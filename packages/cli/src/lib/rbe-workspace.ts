import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Generates the .limrun/ workspace companion for `lim xcode rbe`: a Bazel
 * package pinning the remote fleet's Xcode version and an rc fragment with the
 * remote-execution flags under the `limrun` config. The caller learns the
 * fleet's version key from the instance's RBE status, so the generated config
 * always matches the fleet without any user action; rerunning the command
 * after a fleet Xcode upgrade regenerates the pin.
 */

export const LIMRUN_DIR = '.limrun';
export const TRY_IMPORT_LINE = 'try-import %workspace%/.limrun/bazelrc';
const TRY_IMPORT_COMMENT = '# Added by lim xcode rbe: loads the generated remote-execution config.';

/** Major.minor short alias (e.g. "26.4") used for the SDK default and --xcode_version. */
function shortVersion(versionKey: string): string {
  const parts = versionKey.split('.');
  if (parts.length < 3) {
    throw new Error(`unexpected Xcode version key from the instance: ${versionKey}`);
  }
  return `${parts[0]}.${parts[1]}`;
}

/** Renders one xcode_version rule from a major.minor.patch.build version key. */
function renderXcodeVersionRule(name: string, versionKey: string): string {
  const parts = versionKey.split('.');
  if (parts.length < 3) {
    throw new Error(`unexpected Xcode version key: ${versionKey}`);
  }
  const sdk = `${parts[0]}.${parts[1]}`;
  const shortAlias = `${parts[0]}.${parts[1]}`;
  const fullAlias = `${parts[0]}.${parts[1]}.${parts[2]}`;
  return `xcode_version(
    name = "${name}",
    aliases = [
        "${shortAlias}",
        "${fullAlias}",
    ],
    default_ios_sdk_version = "${sdk}",
    default_macos_sdk_version = "${sdk}",
    default_tvos_sdk_version = "${sdk}",
    default_watchos_sdk_version = "${sdk}",
    version = "${versionKey}",
)`;
}

/**
 * Detects the client's local Xcode version key (major.minor.patch.build) via
 * `xcodebuild -version`, or returns null when there is no usable local Xcode
 * (a Linux/Windows client, or a mac without command-line tools). Used to build
 * the `local_versions` set so local/host-tool actions resolve against the
 * Xcode the client actually has, while the fleet's version stays remote-only.
 */
export function detectLocalXcodeVersionKey(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const out = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' });
    const versionMatch = out.match(/Xcode\s+(\d+)\.(\d+)(?:\.(\d+))?/);
    const buildMatch = out.match(/Build version\s+(\S+)/);
    if (!versionMatch || !buildMatch) {
      return null;
    }
    const major = versionMatch[1];
    const minor = versionMatch[2];
    const patch = versionMatch[3] ?? '0';
    return `${major}.${minor}.${patch}.${buildMatch[1]}`;
  } catch {
    return null;
  }
}

/**
 * Renders the generated Bazel package pinning the remote Xcode version.
 *
 * remoteVersionKey is the fleet's `xcodebuild -version` in major.minor.patch.build
 * form (e.g. 26.4.0.17E192). localVersionKey is the client's own Xcode version
 * in the same form, or null when the client has no local Xcode (Linux/Windows).
 *
 * The config uses Bazel's remote/local Xcode split rather than a single
 * version bucket. A single-bucket `xcode_config(default=, versions=)` resolves
 * the pinned version with availability UNKNOWN, which leaves Apple/Swift
 * actions eligible for LOCAL execution; a locally-scheduled action then runs
 * `xcode-locator <version>` on the client to resolve DEVELOPER_DIR and aborts
 * the whole build when the client lacks that exact Xcode (a mac with a
 * different version) or has no Xcode at all (Linux/Windows). Declaring the
 * fleet's version under `remote_versions` ONLY (so it is not also in
 * `local_versions`) resolves it as availability REMOTE, which stamps
 * `no-local` on Apple actions so they never run on the client.
 *
 * `local_versions` is built from the client's own Xcode, not Bazel's
 * `@local_config_xcode//:host_available_xcodes` (that repo is not visible from
 * the main module under bzlmod, and is never generated off-darwin):
 * - mac client: the detected local Xcode (e.g. 26.5), so local/host-tool
 *   actions still run with the dev's real Xcode while 26.4 stays remote-only.
 * - no local Xcode (Linux/Windows): a synthetic set whose default is the same
 *   pinned version, so with `--xcode_version` the version is mutually
 *   available and resolves without demanding a real local DEVELOPER_DIR.
 */
export function renderXcodeConfigBuild(
  remoteVersionKey: string,
  localVersionKey: string | null,
): string {
  const remoteRule = renderXcodeVersionRule('remote_xcode', remoteVersionKey);

  let localBlock: string;
  if (localVersionKey && shortVersion(localVersionKey) !== shortVersion(remoteVersionKey)) {
    // The client has its own Xcode, distinct from the fleet's. Declare it as
    // the local set so local actions resolve against it; the fleet version is
    // in remote_versions only, hence remote-only (no client-side locator).
    localBlock = `
# The client's own local Xcode (distinct from the fleet's). Local/host-tool
# actions resolve against this; the fleet version above is remote-only.
${renderXcodeVersionRule('local_xcode', localVersionKey)}

available_xcodes(
    name = "local_xcodes",
    default = ":local_xcode",
    versions = [":local_xcode"],
)
`;
  } else {
    // No distinct local Xcode (Linux/Windows, or the client happens to run the
    // same version as the fleet). A synthetic set defaulting to the pinned
    // version keeps available_xcodes' mandatory default satisfied without
    // naming an Xcode the machine may not physically have.
    localBlock = `
# Synthetic local Xcode set for clients with no distinct local Xcode
# (Linux/Windows). Its mandatory default points at the same version as the
# remote pin so resolution never demands a real local DEVELOPER_DIR for a
# version this machine does not physically have.
available_xcodes(
    name = "local_xcodes",
    default = ":remote_xcode",
    versions = [":remote_xcode"],
)
`;
  }

  return `# Generated by lim xcode rbe. Do not edit; rerun the command to refresh.
#
# Pins the Xcode version Bazel declares for remote actions to the limrun
# fleet's Xcode, independent of the Xcode installed on this machine (or its
# absence on a Linux/Windows client). Selected via the generated
# .limrun/bazelrc (--config=limrun).
${remoteRule}

# The remote fleet's Xcode set (single pinned version).
available_xcodes(
    name = "remote_xcodes",
    default = ":remote_xcode",
    versions = [":remote_xcode"],
)
${localBlock}
xcode_config(
    name = "remote_xcode_config",
    remote_versions = ":remote_xcodes",
    local_versions = ":local_xcodes",
)
`;
}

/**
 * Renders the rc fragment with the remote-execution flags under
 * --config=limrun.
 *
 * - `--xcode_version` pins the fleet's version: without it, a mac client
 *   lacking that exact version has no mutual version and silently falls back
 *   to its LOCAL default, shipping the wrong version to the remote worker via
 *   XCODE_VERSION_OVERRIDE (the worker then rejects it).
 * - `--strategy=SwiftCompile=remote` / `--strategy=Genrule=remote` override
 *   mnemonic-specific strategies a workspace may pin (rules_swift defaults
 *   SwiftCompile to a local persistent `worker`; repos often pin Genrule to
 *   `standalone`). Those run locally and break RBE: a local Swift worker can't
 *   run on a Linux client at all, and on a mac it would demand the fleet's
 *   Xcode locally. --spawn_strategy=remote does not override per-mnemonic
 *   pins, so these explicit overrides are required.
 * - PATH includes /usr/sbin:/sbin so genrules that probe `sysctl` (e.g.
 *   `hw.logicalcpu` for `make -j`) resolve it on the worker.
 * - `--extra_execution_platforms` is emitted ONLY for non-mac clients: a Linux
 *   host has no auto-detected darwin execution platform, so the Apple/Swift
 *   toolchain (exec_compatible_with macos) needs one registered to route
 *   actions to the mac RBE pool. On a mac it is HARMFUL: it makes bazel run
 *   exec-config actions on the local host instead of the remote worker, which
 *   then demand a local Xcode.
 */
export function renderLimrunBazelrc(
  port: number,
  versionKey: string,
  isMacClient: boolean,
): string {
  const execPlatform = isMacClient
    ? ''
    : 'build:limrun --extra_execution_platforms=@build_bazel_apple_support//platforms:darwin_arm64\n';
  return `# Generated by lim xcode rbe. Do not edit; rerun the command to refresh.
build:limrun --remote_executor=grpc://127.0.0.1:${port}
build:limrun --remote_default_exec_properties=OSFamily=Darwin
build:limrun --spawn_strategy=remote
build:limrun --noremote_local_fallback
build:limrun --strategy=SwiftCompile=remote
build:limrun --strategy=Genrule=remote
build:limrun --xcode_version_config=//.limrun:remote_xcode_config
build:limrun --xcode_version=${shortVersion(versionKey)}
${execPlatform}build:limrun --action_env=PATH=/usr/bin:/bin:/usr/sbin:/sbin
`;
}

/**
 * Idempotently ensures the workspace .bazelrc try-imports the generated
 * fragment. Creates .bazelrc when missing. Returns true when the file changed.
 */
export function ensureTryImport(workspaceDir: string): boolean {
  const bazelrcPath = path.join(workspaceDir, '.bazelrc');
  let current = '';
  if (fs.existsSync(bazelrcPath)) {
    current = fs.readFileSync(bazelrcPath, 'utf8');
    if (current.includes(TRY_IMPORT_LINE)) {
      return false;
    }
  }
  const block = `${TRY_IMPORT_COMMENT}\n${TRY_IMPORT_LINE}\n`;
  const next = current === '' ? block : `${current.replace(/\n*$/, '\n\n')}${block}`;
  fs.writeFileSync(bazelrcPath, next);
  return true;
}

export type RbeWorkspaceFiles = {
  buildFile: string;
  bazelrcFragment: string;
  bazelrcUpdated: boolean;
};

/**
 * Writes .limrun/{BUILD,bazelrc,.gitignore} into the workspace and wires the
 * try-import. The .gitignore containing "*" makes the directory self-ignoring
 * so nothing else in the user's repo needs to change.
 */
export function writeRbeWorkspaceFiles(
  workspaceDir: string,
  xcodeVersionKey: string,
  port: number,
  localXcodeVersionKey: string | null = detectLocalXcodeVersionKey(),
  isMacClient: boolean = process.platform === 'darwin',
): RbeWorkspaceFiles {
  const dir = path.join(workspaceDir, LIMRUN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const buildFile = path.join(dir, 'BUILD');
  const bazelrcFragment = path.join(dir, 'bazelrc');
  fs.writeFileSync(buildFile, renderXcodeConfigBuild(xcodeVersionKey, localXcodeVersionKey));
  fs.writeFileSync(bazelrcFragment, renderLimrunBazelrc(port, xcodeVersionKey, isMacClient));
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  const bazelrcUpdated = ensureTryImport(workspaceDir);
  return { buildFile, bazelrcFragment, bazelrcUpdated };
}
