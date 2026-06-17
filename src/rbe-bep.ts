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
 * its own RBE cache and installs it — no round-trip. The generated bazelrc sets
 * `--remote_download_outputs=minimal` to skip the (unneeded) local download by
 * default; overriding it (e.g. `--remote_download_outputs=toplevel` on the command
 * line) to materialize the .ipa locally does not affect this parser.
 *
 * A fully-cached rebuild (0 actions executed) still emits the bytestream URI and
 * reproduces the same digest, so the auto-install watcher can rely on this parser
 * after a no-op or revert (e.g. `git stash`) rebuild. Verified empirically.
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
    buildFinished?: unknown;
  };
  started?: { uuid?: string };
  finished?: { overallSuccess?: boolean; exitCode?: { name?: string; code?: number } };
  /** Bazel sets this on the final BEP event once the stream is fully flushed. */
  lastMessage?: boolean;
  completed?: {
    success?: boolean;
    outputGroup?: Array<{ name?: string; fileSets?: Array<{ id?: string }> }>;
  };
  namedSetOfFiles?: {
    files?: Array<{ name?: string; uri?: string }>;
    fileSets?: Array<{ id?: string }>;
  };
};

/**
 * Why a BEP could not yield an .ipa digest for a label.
 *
 * `terminal` failures will not resolve by re-reading the same completed BEP
 * (the build used the wrong flags); `no-build` / `no-output` / `no-ipa` are
 * transient while the build is still flushing and become terminal only once
 * the build is confirmed complete. The watcher uses this to decide whether to
 * retry the read or to log-once and give up.
 */
export type RbeBepErrorKind = 'no-build' | 'no-output' | 'no-ipa' | 'local-only' | 'non-sha256';

export class RbeBepError extends Error {
  readonly kind: RbeBepErrorKind;
  constructor(kind: RbeBepErrorKind, message: string) {
    super(message);
    this.name = 'RbeBepError';
    this.kind = kind;
  }

  /**
   * True when re-reading the same (completed) BEP cannot help — the build was
   * produced with flags the instance cache can't use (local download or a
   * non-SHA256 digest). The watcher logs these once instead of retrying.
   */
  get terminal(): boolean {
    return this.kind === 'local-only' || this.kind === 'non-sha256';
  }
}

/** A SHA-256 digest is exactly 64 lowercase hex chars; the instance CAS is keyed by it. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Extracts (digestFunction, hash, size) from a Bazel/REAPI bytestream blob URI:
 * `bytestream://…/blobs/[<digest_function>/]<hash>/<size>`. The digest-function
 * segment is OMITTED for functions inferable from hash length (SHA-256 among
 * them) and PRESENT otherwise — notably BLAKE3, whose 256-bit output is also 64
 * hex chars and so cannot be told apart from SHA-256 by length. Capturing the
 * function lets the caller reject a non-SHA256 build (e.g. Bazel 9's BLAKE3
 * default) with the right guidance instead of misreading the URI.
 */
function parseBytestreamDigest(
  uri: string,
): { digestFunction?: string; hash: string; sizeBytes: number } | null {
  // Anchor on the /blobs/[func/]<hash>/<size> tail (tolerating an instance-name
  // prefix). The optional function group only matches a real function segment:
  // for the SHA-256 form (`/blobs/<hash>/<size>`) it backtracks to absent, and
  // for `/blobs/blake3/<hash>/<size>` the non-hex 'l'/'k' force it to be captured
  // as the function rather than the hash.
  const m = uri.match(/\/blobs\/(?:([a-z0-9_]+)\/)?([0-9a-fA-F]+)\/(\d+)(?:$|\/)/);
  if (!m || m[2] === undefined || m[3] === undefined) return null;
  return {
    ...(m[1] !== undefined ? { digestFunction: m[1] } : {}),
    hash: m[2].toLowerCase(),
    sizeBytes: Number(m[3]),
  };
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

/** Parses the BEP stream into events, ignoring partial/garbled lines. */
function parseEvents(bepJson: string): BepEvent[] {
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
  return events;
}

export type BepCompletion = {
  /**
   * True once Bazel has flushed the terminal event (`lastMessage`), so every
   * earlier event — including the .ipa's namedSetOfFiles — is durably on disk.
   * Gate the digest read on this, NOT on the presence of `buildFinished`:
   * `buildFinished` is followed by `buildToolLogs` and `buildMetrics`
   * (the `lastMessage` carrier), so it is not the last line.
   */
  complete: boolean;
  /** Whether the build itself succeeded (overallSuccess / exit code 0). */
  success: boolean;
  /** Bazel's invocation UUID — distinguishes one build from the next. */
  invocationId?: string;
};

/**
 * Inspects a BEP stream for build completion. The watcher reads the BEP on every
 * change but only acts once `complete` is true (the stream is fully flushed) and
 * `success` is true (the build did not fail). `invocationId` lets the watcher act
 * once per build even when consecutive builds reproduce the same .ipa digest
 * (e.g. a `git stash` revert that rebuilds to an earlier digest).
 */
export function inspectBuildCompletion(bepJson: string): BepCompletion {
  let complete = false;
  let sawFinished = false;
  let success = false;
  let invocationId: string | undefined;
  for (const e of parseEvents(bepJson)) {
    if (e.started?.uuid) invocationId = e.started.uuid;
    if (e.id?.buildFinished !== undefined || e.finished !== undefined) {
      sawFinished = true;
      // proto3 JSON omits zero-valued scalars, so a SUCCESS exit code serializes
      // as `{name:"SUCCESS"}` with `code` omitted — checking `code === 0` would be
      // a dead branch. Trust overallSuccess (present=true on success, omitted on
      // failure) and fall back to the exit code's symbolic name.
      success = e.finished?.overallSuccess === true || e.finished?.exitCode?.name === 'SUCCESS';
    }
    if (e.lastMessage === true) complete = true;
  }
  return {
    complete,
    success: sawFinished && success,
    ...(invocationId !== undefined ? { invocationId } : {}),
  };
}

/** Indexes namedSetOfFiles events by id for transitive fileset resolution. */
function indexNamedSets(events: BepEvent[]): Map<string, NonNullable<BepEvent['namedSetOfFiles']>> {
  const namedSets = new Map<string, NonNullable<BepEvent['namedSetOfFiles']>>();
  for (const e of events) {
    const id = e.id?.namedSet?.id;
    if (id && e.namedSetOfFiles) namedSets.set(id, e.namedSetOfFiles);
  }
  return namedSets;
}

/**
 * Resolves the top-level `.ipa` CAS digest for one successful target's
 * `completed` event, walking its default output group's filesets transitively.
 * Throws a typed RbeBepError when no .ipa is present, it was materialized
 * locally (`file://`), or it carries a non-SHA256 (e.g. BLAKE3) digest.
 */
function resolveIpaDigest(
  label: string,
  completed: NonNullable<BepEvent['completed']>,
  namedSets: Map<string, NonNullable<BepEvent['namedSetOfFiles']>>,
): BepIpaDigest {
  // Default output group -> the fileSet (namedSetOfFiles) ids holding its outputs.
  const rootFileSetIds = (completed.outputGroup ?? [])
    .filter((og) => og.name === 'default' || !og.name)
    .flatMap((og) => (og.fileSets ?? []).map((fs) => fs.id))
    .filter((id): id is string => !!id);
  if (rootFileSetIds.length === 0) {
    throw new RbeBepError('no-output', `Build of ${label} reported no default output files.`);
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
        // The instance cache is keyed by SHA-256. Reject any other digest
        // function — Bazel 9 defaults to BLAKE3, whose URI carries an explicit
        // `blake3` function segment (and whose 64-hex hash is indistinguishable
        // from SHA-256 by length, so the hash form alone can't catch it). Surface
        // it here with the fix rather than letting it fail later as a cryptic
        // server cache miss.
        const isSha256 =
          digest.digestFunction === undefined ?
            SHA256_HEX.test(digest.hash)
          : digest.digestFunction === 'sha256';
        if (!isSha256) {
          const got = digest.digestFunction ?? `${digest.hash.length} hex chars`;
          throw new RbeBepError(
            'non-sha256',
            `Built ${f.name} with a non-SHA256 digest (${got}; Bazel 9 defaults to BLAKE3). The instance ` +
              `cache is keyed by SHA-256 — rebuild with --digest_function=sha256, e.g. ` +
              `\`bazelisk --digest_function=sha256 build --config=limrun ${label}\`.`,
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
    throw new RbeBepError(
      'local-only',
      `Found ${label}'s .ipa (${localOnlyIpa}) but it has no remote (bytestream) digest — it was ` +
        `built locally, not remotely executed. Ensure you built with --config=limrun so the .ipa is ` +
        `produced in the instance's cache.`,
    );
  }
  throw new RbeBepError('no-ipa', `No .ipa output found for ${label} in the build event log.`);
}

/**
 * Finds the `.ipa` produced for `label` in a BEP stream and returns its CAS
 * digest. Throws a typed RbeBepError when the target/.ipa is absent, its output
 * was materialized locally (a `file://` URI) instead of left in CAS, or it was
 * built with a non-SHA256 digest the instance cache cannot resolve.
 */
export function parseTopLevelIpaDigest(bepJson: string, label: string): BepIpaDigest {
  const canonical = canonicalizeLabel(label);
  const events = parseEvents(bepJson);

  // The successful TargetComplete for the requested label (matched against the
  // canonical //pkg:name form Bazel records, so `//App` matches `//App:App`).
  const completed = events.find((e) => e.id?.targetCompleted?.label === canonical && e.completed?.success)
    ?.completed;
  if (!completed) {
    throw new RbeBepError(
      'no-build',
      `No successful build of ${label} found in the build event log. ` +
        `Build it first with --config=limrun (e.g. \`bazelisk --digest_function=sha256 build --config=limrun ${label}\`).`,
    );
  }

  return resolveIpaDigest(label, completed, indexNamedSets(events));
}
