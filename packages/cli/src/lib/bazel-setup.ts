import fs from 'fs';
import path from 'path';
import Limrun, { APIError } from '@limrun/api';
import {
  LIMRUN_DIR,
  detectBazelMajorVersion,
  ensureTryImport,
  isBazel9OrLater,
  renderXcodeConfigBuild,
} from '@limrun/api';

/**
 * Client configuration for the region's build plane: Bazel remote execution
 * and caching, reached with plain Bazel and a credential helper. Apple actions
 * run on Xcode workers; Android actions run on Linux workers.
 */

/** What the director tells a client about the build plane. */
export type BazelSetup = {
  /** The plane's gRPC endpoint, e.g. grpcs://buildplane.eu-north1.limrun.net:4443. */
  endpoint: string;
  /** The REv2 instance name to send: the organization ID. */
  instanceName: string;
  region: string;
  /** Xcode version keys the workers carry, e.g. 26.4.0.17E192. */
  xcodeVersions: string[];
  /** The toolchain version Linux workers carry, named in the Linux platform. */
  linuxToolchains: string;
};

/** The executable Bazel runs as its credential helper, beside `lim`. */
export const CREDENTIAL_HELPER = 'lim-bazel-credentials';

/**
 * Whether Bazel can find the credential helper on PATH. The npm package links
 * it beside `lim`; a standalone tarball install links only `lim`.
 */
export function credentialHelperOnPath(): boolean {
  const names =
    process.platform === 'win32' ?
      ['.cmd', '.exe'].map((ext) => CREDENTIAL_HELPER + ext)
    : [CREDENTIAL_HELPER];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && names.some((name) => fs.existsSync(path.join(dir, name))));
}

/** How long a minted token lives; Bazel asks again before it expires. */
const TOKEN_TTL_SECONDS = 3600;
/** What a build needs: read and write the cache, and run actions. */
const BUILD_SCOPES = ['remotecache:*:all', 'remoteexecution:*:all'];
/** What a viewer's credential can still mint: cache reads alone. */
const READ_SCOPES = ['remotecache:*:read'];

/** The credential helper's answer: headers for the plane, and when they expire. */
export type BazelCredentials = { headers: { Authorization: string[] }; expires: string };

/**
 * Mints a short-lived scoped token for the plane from the caller's own
 * credential. A viewer may only read the cache, so it gets what it may have.
 */
export async function bazelCredentials(client: Limrun): Promise<BazelCredentials> {
  const mint = (scopes: string[]) => client.scopedTokens.create({ scopes, ttlSeconds: TOKEN_TTL_SECONDS });
  const token = await mint(BUILD_SCOPES).catch((err: unknown) => {
    if (err instanceof APIError && err.status === 403) return mint(READ_SCOPES);
    throw err;
  });
  return { headers: { Authorization: [`Bearer ${token.token}`] }, expires: token.expiresAt };
}

/** Asks the director for the build plane closest to the caller, or in region. */
export async function getBazelSetup(client: Limrun, region?: string): Promise<BazelSetup> {
  return client.get('/v1/bazel_setup', { query: region ? { region } : {} }) as Promise<BazelSetup>;
}

/** The oldest Bazel the generated configuration works with. */
export const MIN_BAZEL_MAJOR = 8;

/**
 * Why the workspace's pinned Bazel is too old for the build plane, or null.
 * Bazel 8 named external repositories the way the generated flags do.
 */
export function bazelTooOld(bazelMajor: number | null): string | null {
  if (bazelMajor === null || bazelMajor >= MIN_BAZEL_MAJOR) return null;
  return `This workspace pins Bazel ${bazelMajor} in .bazelversion; the build plane setup needs Bazel ${MIN_BAZEL_MAJOR} or later.`;
}

/**
 * Which kinds of build the workspace has, from its root MODULE.bazel, and
 * whether its .bazelrc already picks the Java runtime.
 */
export type WorkspaceKinds = { apple: boolean; android: boolean; javaRuntime?: boolean };

export function detectWorkspaceKinds(workspaceRoot: string): WorkspaceKinds {
  const module = readModule(workspaceRoot);
  return {
    apple: hasBazelDep(module, 'rules_apple') || hasBazelDep(module, 'apple_support'),
    android: hasBazelDep(module, 'rules_android'),
    javaRuntime: setsJavaRuntime(workspaceRoot),
  };
}

/** Whether the workspace's .bazelrc sets the Java runtime itself. */
function setsJavaRuntime(workspaceRoot: string): boolean {
  let rc = '';
  try {
    rc = fs.readFileSync(path.join(workspaceRoot, '.bazelrc'), 'utf8');
  } catch {
    return false;
  }
  return rc
    .split('\n')
    .some((line) => !line.trimStart().startsWith('#') && /--java_runtime_version=/.test(line));
}

function readModule(workspaceRoot: string): string {
  try {
    return fs.readFileSync(path.join(workspaceRoot, 'MODULE.bazel'), 'utf8');
  } catch {
    return '';
  }
}

function hasBazelDep(module: string, name: string): boolean {
  return new RegExp(`bazel_dep\\(\\s*name\\s*=\\s*"${name}"`).test(module);
}

/**
 * The lines an Android workspace's root MODULE.bazel needs for Linux workers,
 * for each piece it lacks. These cannot live in a bazelrc. The Android SDK
 * comes per OS from hermetic_android_toolchains, protobuf 35 ships a
 * prebuilt protoc, and rules_cc and rules_java back the toolchains setup
 * writes into .limrun.
 */
export function missingAndroidModuleLines(workspaceRoot: string): string {
  const module = readModule(workspaceRoot);
  const blocks: string[] = [];
  const deps: Array<[string, string]> = [
    ['rules_cc', 'bazel_dep(name = "rules_cc", version = "0.2.17")'],
    ['rules_java', 'bazel_dep(name = "rules_java", version = "9.3.0")'],
    ['protobuf', 'bazel_dep(name = "protobuf", version = "35.1", repo_name = "com_google_protobuf")'],
  ];
  for (const [name, line] of deps) {
    if (!hasBazelDep(module, name)) blocks.push(line);
  }
  if (!hasBazelDep(module, 'hermetic_android_toolchains')) {
    blocks.push(`# The Android SDK for each OS a build runs on, Linux workers included.
bazel_dep(name = "hermetic_android_toolchains", version = "0.5.0")

android = use_extension("@hermetic_android_toolchains//:extensions.bzl", "android", dev_dependency = True)
android.sdk(
    build_tools_version = "36.0.0",
    version = "36",
)
use_repo(android, "androidsdk")

rules_android_sdk = use_extension("@rules_android//rules/android_sdk_repository:rule.bzl", "android_sdk_repository_extension", dev_dependency = True)
override_repo(rules_android_sdk, "androidsdk")

register_toolchains("@androidsdk//:all", dev_dependency = True)`);
  }
  if (blocks.length === 0) return '';
  return `\n# Added by lim bazel setup for Limrun's Linux build workers.\n${blocks.join('\n\n')}\n`;
}

/** Appends lines to the workspace's root MODULE.bazel. */
export function appendModuleLines(workspaceRoot: string, lines: string): void {
  const file = path.join(workspaceRoot, 'MODULE.bazel');
  const current = readModule(workspaceRoot);
  fs.writeFileSync(file, current.replace(/\n*$/, '\n') + lines);
}

/** The Xcode version a build pins: the fleet's first, as `lim xcode rbe` does. */
function pinnedXcode(setup: BazelSetup): string {
  const version = setup.xcodeVersions[0];
  if (!version) throw new Error('The build plane reports no Xcode version.');
  return version;
}

function shortXcode(versionKey: string): string {
  const [major, minor] = versionKey.split('.');
  return `${major}.${minor}`;
}

function planeHost(endpoint: string): string {
  return new URL(endpoint).hostname;
}

/**
 * Renders .limrun/bazelrc for the plane under --config=limrun. Every action
 * runs remotely, and no token is written: Bazel asks the credential helper
 * for one per host, and again before it expires.
 */
export function renderPlaneBazelrc(
  setup: BazelSetup,
  kinds: WorkspaceKinds,
  isMacClient: boolean,
  bazelMajor: number | null,
): string {
  const host = planeHost(setup.endpoint);
  const lines = [
    '# Generated by lim bazel setup. Do not edit; rerun the command to refresh.',
    `build:limrun --remote_executor=${setup.endpoint}`,
    `build:limrun --bes_backend=${setup.endpoint}`,
    `build:limrun --remote_instance_name=${setup.instanceName}`,
    `build:limrun --credential_helper=${host}=${CREDENTIAL_HELPER}`,
    'build:limrun --bes_upload_mode=nowait_for_upload_complete',
    'build:limrun --bes_timeout=60s',
    // A workspace's own --remote_cache would split inputs and outputs
    // across two stores the plane cannot reconcile.
    'build:limrun --remote_cache=',
    'build:limrun --remote_timeout=600',
    'build:limrun --spawn_strategy=remote',
    'build:limrun --noremote_local_fallback',
    'build:limrun --strategy=Genrule=remote',
    'build:limrun --modify_execution_info=.*=-no-remote,.*=-no-remote-exec',
    'build:limrun --remote_download_outputs=toplevel',
  ];
  if (kinds.apple) {
    const xcode = pinnedXcode(setup);
    lines.push(
      'build:limrun --strategy=SwiftCompile=remote',
      'build:limrun --xcode_version_config=//.limrun:remote_xcode_config',
      `build:limrun --xcode_version=${shortXcode(xcode)}`,
      'build:limrun --ios_multi_cpus=sim_arm64',
      'build:limrun --action_env=PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    );
  }
  if (kinds.android) {
    // Linux first, so Android and Java actions run on Linux workers, while
    // Apple toolchains still pick the macOS platform.
    lines.push(
      'common:limrun --extra_execution_platforms=//.limrun:linux_x86_64,//.limrun:macos_arm64',
      'common:limrun --platforms=//.limrun:linux_x86_64',
      // Without it, output paths carry the client's CPU, so a Mac and a
      // Linux client miss each other's cache entries.
      'common:limrun --experimental_platform_in_output_dir',
      'common:limrun --extra_toolchains=//.limrun:all',
      'common:limrun --repo_env=ACCEPTED_ANDROID_SDK_LICENSE_VERSION=36',
      // Workers carry no python3; rules_python tools run on the hermetic
      // Python instead.
      'common:limrun --@@rules_python+//python/config_settings:bootstrap_impl=script',
    );
    if (!kinds.javaRuntime) {
      // The workers carry JDK 17, 21 and 25, and .limrun registers
      // toolchains that run them by path, so clients never upload one. A
      // workspace that picks its own version keeps it.
      lines.push(
        'common:limrun --java_runtime_version=remotejdk_17',
        'common:limrun --tool_java_runtime_version=remotejdk_17',
      );
    }
  } else if (kinds.apple) {
    lines.push('build:limrun --remote_default_exec_properties=OSFamily=macos');
    if (!isMacClient) {
      // A Linux client has no darwin platform of its own to route Apple
      // toolchains to.
      lines.push(
        'build:limrun --extra_execution_platforms=@build_bazel_apple_support//platforms:darwin_arm64',
      );
    }
  }
  if (isBazel9OrLater(bazelMajor)) {
    // A startup option applies to every command in the workspace, and Bazel
    // before 9 refuses to start with one it does not know.
    lines.push(
      '',
      '# Later machines fetch external repositories from the remote cache',
      '# instead of the internet, once any machine of the organization has.',
      'startup --experimental_remote_repo_contents_cache',
    );
  }
  lines.push(
    '',
    '# A user.limrun.bazelrc at the workspace root is try-imported last, so it',
    '# can extend or override anything above.',
    'try-import %workspace%/user.limrun.bazelrc',
    '',
  );
  return lines.join('\n');
}

/**
 * Renders .limrun/BUILD: the Xcode version pin for Apple builds, and for
 * Android builds the two execution platforms and the workers' JDK and C
 * toolchains.
 */
export function renderPlaneBuild(
  setup: BazelSetup,
  kinds: WorkspaceKinds,
  bazelMajor: number | null,
): string {
  const parts: string[] = [];
  if (kinds.apple) {
    parts.push(renderXcodeConfigBuild(pinnedXcode(setup), isBazel9OrLater(bazelMajor)));
  }
  if (kinds.android) {
    parts.push(renderAndroidBuild(setup.linuxToolchains));
  }
  return parts.join('\n');
}

function renderAndroidBuild(toolchains: string): string {
  return `# Generated by lim bazel setup. Do not edit; rerun the command to refresh.
load("@rules_cc//cc/toolchains:cc_toolchain.bzl", "cc_toolchain")
load("@rules_java//java/toolchains:java_runtime.bzl", "java_runtime")
load(":linux_cc_toolchain_config.bzl", "linux_cc_toolchain_config")

# The workers' platforms. limrun-toolchains names the JDKs a Linux worker's
# image carries; it is part of every Linux action's cache key.
platform(
    name = "linux_x86_64",
    constraint_values = [
        "@platforms//os:linux",
        "@platforms//cpu:x86_64",
    ],
    exec_properties = {
        "OSFamily": "linux",
        "limrun-toolchains": "${toolchains}",
    },
)

platform(
    name = "macos_arm64",
    constraint_values = [
        "@platforms//os:macos",
        "@platforms//cpu:arm64",
    ],
    exec_properties = {"OSFamily": "macos"},
)

# Linux workers carry JDK 17, 21 and 25 at /opt/java/<version>. Each runtime
# answers both its plain and its remotejdk_ version name, so rules_java picks
# it over a downloaded JDK.
[java_runtime(
    name = "worker_jdk%d" % v,
    java_home = "/opt/java/%d" % v,
    version = v,
) for v in (17, 21, 25)]

[config_setting(
    name = "jdk%d_%s" % (v, k),
    values = {"java_runtime_version": n},
) for v in (17, 21, 25) for (k, n) in (("plain", str(v)), ("remote", "remotejdk_%d" % v))]

[alias(
    name = "jdk%d_setting" % v,
    actual = select({
        ":jdk%d_plain" % v: ":jdk%d_plain" % v,
        "//conditions:default": ":jdk%d_remote" % v,
    }),
) for v in (17, 21, 25)]

[toolchain(
    name = "worker_jdk%d_runtime" % v,
    target_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
    target_settings = [":jdk%d_setting" % v],
    toolchain = ":worker_jdk%d" % v,
    toolchain_type = "@bazel_tools//tools/jdk:runtime_toolchain_type",
) for v in (17, 21, 25)]

[toolchain(
    name = "worker_jdk%d_bootstrap" % v,
    exec_compatible_with = ["@platforms//os:linux", "@platforms//cpu:x86_64"],
    target_settings = [":jdk%d_setting" % v],
    toolchain = ":worker_jdk%d" % v,
    toolchain_type = "@bazel_tools//tools/jdk:bootstrap_runtime_toolchain_type",
) for v in (17, 21, 25)]

# Linux workers carry clang at fixed paths; this toolchain runs it by path,
# for build steps that compile C or C++.
filegroup(name = "empty")

linux_cc_toolchain_config(name = "linux_cc_config")

cc_toolchain(
    name = "linux_cc",
    all_files = ":empty",
    ar_files = ":empty",
    as_files = ":empty",
    compiler_files = ":empty",
    dwp_files = ":empty",
    linker_files = ":empty",
    objcopy_files = ":empty",
    strip_files = ":empty",
    toolchain_config = ":linux_cc_config",
)

toolchain(
    name = "linux_cc_toolchain",
    exec_compatible_with = [
        "@platforms//os:linux",
        "@platforms//cpu:x86_64",
    ],
    target_compatible_with = [
        "@platforms//os:linux",
        "@platforms//cpu:x86_64",
    ],
    toolchain = ":linux_cc",
    toolchain_type = "@bazel_tools//tools/cpp:toolchain_type",
)
`;
}

const LINUX_CC_TOOLCHAIN_CONFIG = `# Generated by lim bazel setup. Do not edit; rerun the command to refresh.
"""The Linux workers' C and C++ toolchain: clang at fixed paths in the worker
image, run by path. Its version is part of limrun-toolchains."""

load("@rules_cc//cc/common:cc_common.bzl", "cc_common")
load("@rules_cc//cc/toolchains:cc_toolchain_config_info.bzl", "CcToolchainConfigInfo")
load("@bazel_tools//tools/cpp:cc_toolchain_config_lib.bzl", "feature", "flag_group", "flag_set", "tool_path")
load("@bazel_tools//tools/build_defs/cc:action_names.bzl", "ACTION_NAMES")

_LINK_ACTIONS = [
    ACTION_NAMES.cpp_link_executable,
    ACTION_NAMES.cpp_link_dynamic_library,
    ACTION_NAMES.cpp_link_nodeps_dynamic_library,
]

def _impl(ctx):
    tools = {
        "gcc": "/usr/bin/clang",
        "cpp": "/usr/bin/clang-cpp",
        "ld": "/usr/bin/ld",
        "ar": "/usr/bin/ar",
        "nm": "/usr/bin/nm",
        "objcopy": "/usr/bin/objcopy",
        "objdump": "/usr/bin/objdump",
        "strip": "/usr/bin/strip",
        "gcov": "/bin/false",
        "dwp": "/bin/false",
        "llvm-cov": "/bin/false",
    }
    return [cc_common.create_cc_toolchain_config_info(
        ctx = ctx,
        toolchain_identifier = "limrun_linux_clang",
        host_system_name = "x86_64-unknown-linux-gnu",
        target_system_name = "x86_64-unknown-linux-gnu",
        target_cpu = "k8",
        target_libc = "glibc",
        compiler = "clang",
        abi_version = "local",
        abi_libc_version = "local",
        tool_paths = [tool_path(name = k, path = v) for k, v in tools.items()],
        # The image's system headers, which actions may include.
        cxx_builtin_include_directories = [
            "/usr/lib/llvm-18/lib/clang/18/include",
            "/usr/local/include",
            "/usr/include",
            "/usr/lib/gcc/x86_64-linux-gnu/13",
            "/usr/bin/../lib/gcc/x86_64-linux-gnu/13",
        ],
        features = [
            feature(
                name = "default_link_flags",
                enabled = True,
                flag_sets = [flag_set(actions = _LINK_ACTIONS, flag_groups = [flag_group(flags = ["-lstdc++", "-lm"])])],
            ),
        ],
    )]

linux_cc_toolchain_config = rule(
    implementation = _impl,
    provides = [CcToolchainConfigInfo],
)
`;

export type PlaneWorkspaceFiles = {
  bazelrc: string;
  buildFile: string;
  /** True when the workspace's .bazelrc gained the try-import. */
  bazelrcUpdated: boolean;
};

/**
 * Writes .limrun/{bazelrc,BUILD,.gitignore}, and the Linux C and C++
 * toolchain for Android builds, then wires the try-import into the
 * workspace's .bazelrc.
 * The .gitignore makes the directory self-ignoring.
 */
export function writePlaneWorkspaceFiles(
  workspaceRoot: string,
  setup: BazelSetup,
  kinds: WorkspaceKinds,
  isMacClient: boolean = process.platform === 'darwin',
): PlaneWorkspaceFiles {
  const dir = path.join(workspaceRoot, LIMRUN_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const bazelrc = path.join(dir, 'bazelrc');
  const buildFile = path.join(dir, 'BUILD');
  const bazelMajor = detectBazelMajorVersion(workspaceRoot);
  fs.writeFileSync(bazelrc, renderPlaneBazelrc(setup, kinds, isMacClient, bazelMajor));
  fs.writeFileSync(buildFile, renderPlaneBuild(setup, kinds, bazelMajor));
  const ccConfig = path.join(dir, 'linux_cc_toolchain_config.bzl');
  if (kinds.android) {
    fs.writeFileSync(ccConfig, LINUX_CC_TOOLCHAIN_CONFIG);
  } else {
    fs.rmSync(ccConfig, { force: true });
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  return { bazelrc, buildFile, bazelrcUpdated: ensureTryImport(workspaceRoot) };
}
