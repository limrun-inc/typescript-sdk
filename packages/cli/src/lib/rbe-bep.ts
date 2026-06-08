/**
 * Parses Bazel's Build Event Protocol (BEP, the `--build_event_json_file`
 * newline-delimited JSON) to find a built target's top-level `.ipa` and its
 * content-addressed (CAS) digest.
 *
 * Under `--config=limrun` the generated bazelrc sets `--remote_download_outputs=
 * minimal`, so outputs are NOT downloaded to the client; their BEP `file`
 * entries instead carry a `bytestream://<host>[/<instance>]/blobs/<hash>/<size>`
 * URI. `lim xcode rbe install` reads that digest and hands it to the instance,
 * which fetches the blob from its own RBE cache and installs it — no round-trip.
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

/** Extracts (hash, size) from a `bytestream://…/blobs/<hash>/<size>` URI. */
function parseBytestreamDigest(uri: string): { hash: string; sizeBytes: number } | null {
  // Tolerate an optional instance-name segment before /blobs/ by anchoring on
  // the /blobs/<hash>/<size> tail rather than a fixed segment count.
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
  const pkg = label.replace(/\/+$/, ''); // strip any trailing slash
  const name = pkg.split('/').pop() ?? '';
  return name ? `${pkg}:${name}` : pkg;
}

/**
 * Finds the `.ipa` produced for `label` in a BEP stream and returns its CAS
 * digest. Throws a descriptive Error when the target/.ipa is absent or its
 * output was materialized locally (a `file://` URI) instead of left in CAS.
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
  const completed = events.find(
    (e) => e.id?.targetCompleted?.label === canonical && e.completed?.success,
  )?.completed;
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
      `Found ${label}'s .ipa (${localOnlyIpa}) but it has no remote (bytestream) digest — its ` +
        `output was downloaded locally. Ensure you built with --config=limrun (which keeps outputs ` +
        `in the instance cache via --remote_download_outputs=minimal).`,
    );
  }
  throw new Error(`No .ipa output found for ${label} in the build event log.`);
}
