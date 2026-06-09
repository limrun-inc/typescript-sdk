/**
 * Parses Bazel's Build Event Protocol (BEP, the `--build_event_json_file`
 * newline-delimited JSON) to find a built target's top-level `.ipa` and its
 * content-addressed (CAS) digest.
 *
 * A remotely-executed output carries a `bytestream://<host>[/<instance>]/blobs/
 * <hash>/<size>` URI in its BEP `file` entry regardless of whether Bazel also
 * downloads the bytes (`--remote_download_outputs`), because the URI names the
 * output's CAS identity, not its local availability. `lim xcode rbe install`
 * reads that digest and hands it to the instance, which fetches the blob from
 * its own RBE cache and installs it — no round-trip. The printed build command
 * passes `--remote_download_outputs=minimal` to skip the (unneeded) local
 * download by default; dropping it does not affect this parser.
 */

export type BepIpaDigest = {
  /** Lowercase hex SHA-256 of the .ipa blob. */
  hash: string;
  /** Size of the .ipa blob in bytes. */
  sizeBytes: number;
  /** The .ipa file name as Bazel reported it (e.g. "App/App.ipa"). */
  ipaName: string;
};

type BepEvent = {
  id?: {
    targetCompleted?: { label?: string };
    namedSet?: { id?: string };
  };
  completed?: {
    success?: boolean;
    outputGroup?: Array<{ name?: string; fileSets?: Array<{ id?: string }> }>;
  };
  namedSetOfFiles?: {
    files?: Array<{ name?: string; uri?: string }>;
    fileSets?: Array<{ id?: string }>;
  };
};

/** A SHA-256 digest is exactly 64 lowercase hex chars; the instance CAS is keyed by it. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Extracts (hash, size) from a `bytestream://…/blobs/<hash>/<size>` URI. */
function parseBytestreamDigest(uri: string): { hash: string; sizeBytes: number } | null {
  // Tolerate an optional instance-name segment before /blobs/ by anchoring on
  // the /blobs/<hash>/<size> tail rather than a fixed segment count. The hash is
  // left length-agnostic here (validated as SHA-256 by the caller).
  const m = uri.match(/\/blobs\/([0-9a-f]+)\/(\d+)(?:$|\/)/);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { hash: m[1], sizeBytes: Number(m[2]) };
}

/**
 * Canonicalizes a Bazel target label to the `//pkg:name` form BEP records.
 * Bazel expands the `//pkg` shorthand to `//pkg:<basename(pkg)>` in its
 * targetCompleted events, so `install //App` must match BEP's `//App:App`.
 */
function canonicalizeLabel(label: string): string {
  if (label.includes(':')) return label;
  // Strip trailing slashes with a linear scan rather than a regex: `/\/+$/`
  // backtracks quadratically on a label of many trailing slashes (CodeQL ReDoS).
  let end = label.length;
  while (end > 0 && label[end - 1] === '/') end--;
  const pkg = label.slice(0, end);
  const name = pkg.split('/').pop() ?? '';
  return name ? `${pkg}:${name}` : pkg;
}

/**
 * Finds the `.ipa` produced for `label` in a BEP stream and returns its CAS
 * digest. Throws a descriptive Error when the target/.ipa is absent, its output
 * was materialized locally (a `file://` URI) instead of left in CAS, or it was
 * built with a non-SHA256 digest the instance cache cannot resolve.
 */
export function parseTopLevelIpaDigest(bepJson: string, label: string): BepIpaDigest {
  const canonical = canonicalizeLabel(label);
  const events: BepEvent[] = [];
  for (const line of bepJson.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as BepEvent);
    } catch {
      // Ignore partial/garbled lines (BEP is flushed incrementally).
    }
  }

  // The successful TargetComplete for the requested label (matched against the
  // canonical //pkg:name form Bazel records, so `//App` matches `//App:App`).
  const completed = events.find((e) => e.id?.targetCompleted?.label === canonical && e.completed?.success)
    ?.completed;
  if (!completed) {
    throw new Error(
      `No successful build of ${label} found in the build event log. ` +
        `Build it first with --config=limrun (e.g. \`bazelisk --digest_function=sha256 build --config=limrun ${label}\`).`,
    );
  }

  // Default output group -> the fileSet (namedSetOfFiles) ids holding its outputs.
  const rootFileSetIds = (completed.outputGroup ?? [])
    .filter((og) => og.name === 'default' || !og.name)
    .flatMap((og) => (og.fileSets ?? []).map((fs) => fs.id))
    .filter((id): id is string => !!id);
  if (rootFileSetIds.length === 0) {
    throw new Error(`Build of ${label} reported no default output files.`);
  }

  // Index namedSetOfFiles by id and walk transitively (sets can nest).
  const namedSets = new Map<string, NonNullable<BepEvent['namedSetOfFiles']>>();
  for (const e of events) {
    const id = e.id?.namedSet?.id;
    if (id && e.namedSetOfFiles) namedSets.set(id, e.namedSetOfFiles);
  }

  const seen = new Set<string>();
  const queue = [...rootFileSetIds];
  // Set to the name of an .ipa that was seen but had no bytestream digest (its
  // output was downloaded locally) — distinguishes that case from "no .ipa at all".
  let localOnlyIpa: string | undefined;
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const set = namedSets.get(id);
    if (!set) continue;
    for (const f of set.files ?? []) {
      if (!f.name || !f.name.endsWith('.ipa')) continue;
      const digest = f.uri ? parseBytestreamDigest(f.uri) : null;
      if (digest) {
        // The instance cache is keyed by SHA-256. A non-64-hex digest means the
        // build used a different digest function (Bazel 9 defaults to BLAKE3),
        // which the server CAS cannot resolve — surface that clearly here rather
        // than letting it fail later as a cryptic cache miss.
        if (!SHA256_HEX.test(digest.hash)) {
          throw new Error(
            `Built ${f.name} with a non-SHA256 digest (got ${digest.hash.length} hex chars, expected 64; ` +
              `likely BLAKE3 on Bazel 9). The instance cache is keyed by SHA-256 — rebuild with ` +
              `--digest_function=sha256, e.g. \`bazelisk --digest_function=sha256 build --config=limrun ${label}\`.`,
          );
        }
        return { hash: digest.hash, sizeBytes: digest.sizeBytes, ipaName: f.name };
      }
      localOnlyIpa = f.name;
    }
    for (const nested of set.fileSets ?? []) {
      if (nested.id) queue.push(nested.id);
    }
  }

  if (localOnlyIpa) {
    throw new Error(
      `Found ${label}'s .ipa (${localOnlyIpa}) but it has no remote (bytestream) digest — it was ` +
        `built locally, not remotely executed. Ensure you built with --config=limrun so the .ipa is ` +
        `produced in the instance's cache.`,
    );
  }
  throw new Error(`No .ipa output found for ${label} in the build event log.`);
}
