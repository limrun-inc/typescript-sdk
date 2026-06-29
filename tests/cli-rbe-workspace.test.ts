import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  TRY_IMPORT_LINE,
  detectBazelMajorVersion,
  ensureTryImport,
  findBazelWorkspaceRoot,
  inferBuildTarget,
  renderLimrunBazelrc,
  renderXcodeConfigBuild,
  writeRbeWorkspaceFiles,
} from '../packages/cli/src/lib/rbe-workspace';

const APPLE_SUPPORT_LOADS = [
  'load("@build_bazel_apple_support//xcode:xcode_version.bzl", "xcode_version")',
  'load("@build_bazel_apple_support//xcode:available_xcodes.bzl", "available_xcodes")',
  'load("@build_bazel_apple_support//xcode:xcode_config.bzl", "xcode_config")',
];

describe('rbe workspace generation', () => {
  // bazel appends the build id as a path segment to --bes_results_url; CLI builds this base.
  const BES_URL = 'https://console.limrun.com/builds/sandbox_x';

  test('renderXcodeConfigBuild pins the fleet version and derives sdk defaults', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', false);
    expect(build).toContain('version = "26.4.0.17E192"');
    expect(build).toContain('default_ios_sdk_version = "26.4"');
    expect(build).toContain('"26.4",');
    expect(build).toContain('"26.4.0",');
    expect(build).toContain('name = "remote_xcode_config"');
  });

  test('renderXcodeConfigBuild uses the remote/local split, never a single default bucket', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', false);
    expect(build).toContain('name = "remote_xcodes"');
    expect(build).toContain('remote_versions = ":remote_xcodes"');
    expect(build).toContain('local_versions = ":local_xcodes"');
    // A bare default/versions xcode_config is what triggers the client-side
    // xcode-locator abort; the config must not regress to it.
    expect(build).not.toMatch(/xcode_config\([^)]*\bdefault =/);
    // The fleet version must never be referenced via the invisible bazel repo.
    expect(build).not.toContain('@local_config_xcode');
  });

  test('renderXcodeConfigBuild points BOTH sets at the single fleet pin (mutually available, no remote-only DEBUG)', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', false);
    // Only one xcode_version rule (the fleet pin); both sets default to it, so
    // --xcode_version resolves as BOTH and apple_support emits no "not available
    // locally" notice. A second rule would also risk a duplicate "26.4" alias.
    expect(build.match(/xcode_version\(/g)).toHaveLength(1);
    expect(build).not.toContain('name = "local_xcode"');
    expect(build).toMatch(/available_xcodes\(\s*name = "remote_xcodes",\s*default = ":remote_xcode"/);
    expect(build).toMatch(/available_xcodes\(\s*name = "local_xcodes",\s*default = ":remote_xcode"/);
  });

  test('renderXcodeConfigBuild rejects malformed version keys', () => {
    expect(() => renderXcodeConfigBuild('26', false)).toThrow(/unexpected Xcode version key/);
  });

  test('renderXcodeConfigBuild (emitLoads) loads the Xcode rules from apple_support before any rule', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', true);
    for (const line of APPLE_SUPPORT_LOADS) {
      expect(build).toContain(line);
    }
    // load() must precede the first rule (Starlark requirement).
    expect(build.indexOf('load(')).toBeLessThan(build.indexOf('xcode_version('));
  });

  test('renderXcodeConfigBuild (no emitLoads) emits the rules as native globals, no loads', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', false);
    expect(build).not.toContain('load(');
    // Still emits the rules themselves.
    expect(build).toContain('xcode_config(');
  });

  describe('findBazelWorkspaceRoot', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-root-')));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('walks up from a subdirectory to the MODULE.bazel root', () => {
      fs.writeFileSync(path.join(dir, 'MODULE.bazel'), '');
      const sub = path.join(dir, 'examples', 'integration', 'iOSApp');
      fs.mkdirSync(sub, { recursive: true });
      expect(findBazelWorkspaceRoot(sub)).toBe(dir);
    });

    test('recognizes WORKSPACE and WORKSPACE.bazel markers', () => {
      fs.writeFileSync(path.join(dir, 'WORKSPACE'), '');
      expect(findBazelWorkspaceRoot(dir)).toBe(dir);
    });

    test('returns null when no workspace marker is found up to the root', () => {
      const sub = path.join(dir, 'a', 'b');
      fs.mkdirSync(sub, { recursive: true });
      expect(findBazelWorkspaceRoot(sub)).toBeNull();
    });
  });

  describe('inferBuildTarget', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'infer-')));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const writeBuild = (pkg: string, body: string) => {
      const d = path.join(dir, pkg);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'BUILD.bazel'), body);
    };
    const iosApp = (name: string) =>
      `load("@build_bazel_rules_apple//apple:ios.bzl", "ios_application")\n\nios_application(\n    name = "${name}",\n    bundle_id = "com.x",\n)\n`;

    test('returns the short label when there is exactly one app target', () => {
      writeBuild('App', iosApp('App'));
      // a framework/library nearby must NOT count as an application
      writeBuild(
        'Core/UIComponents',
        'load("@build_bazel_rules_apple//apple:ios.bzl", "ios_framework")\n\nios_framework(\n    name = "UIComponents",\n)\n',
      );
      expect(inferBuildTarget(dir)).toBe('//App');
    });

    test('uses //pkg:name form when the target name differs from the package basename', () => {
      writeBuild('App', iosApp('MyApp'));
      expect(inferBuildTarget(dir)).toBe('//App:MyApp');
    });

    test('returns null when there are multiple app targets (ambiguous)', () => {
      writeBuild('iOSApp', iosApp('iOSApp'));
      writeBuild('macOSApp', 'macos_application(\n    name = "macOSApp",\n)\n');
      expect(inferBuildTarget(dir)).toBeNull();
    });

    test('returns null when there are no app targets', () => {
      writeBuild('lib', 'swift_library(\n    name = "lib",\n)\n');
      expect(inferBuildTarget(dir)).toBeNull();
    });

    test('does not match the load() import of ios_application', () => {
      // a BUILD that only imports the symbol but declares no application target
      writeBuild(
        'tools',
        'load("@build_bazel_rules_apple//apple:ios.bzl", "ios_application")\n\nfilegroup(\n    name = "tools",\n)\n',
      );
      expect(inferBuildTarget(dir)).toBeNull();
    });

    test('skips bazel-* and node_modules dirs', () => {
      writeBuild('App', iosApp('App'));
      writeBuild('bazel-out/x', iosApp('Generated'));
      writeBuild('node_modules/pkg', iosApp('Vendored'));
      expect(inferBuildTarget(dir)).toBe('//App');
    });

    test('ignores a commented-out application rule (no phantom match into a later rule)', () => {
      // The commented opening must not set the "in app rule" state and capture
      // the following library's name as an application target.
      writeBuild(
        'App',
        '# ios_application(\n#     name = "OldApp",\n# )\n\nswift_library(\n    name = "AppLib",\n)\n',
      );
      expect(inferBuildTarget(dir)).toBeNull();
    });

    test('picks the real app when a commented rule precedes it', () => {
      writeBuild(
        'App',
        '# ios_application(\n#     name = "OldApp",\n# )\n\nios_application(\n    name = "App",\n    bundle_id = "com.x",\n)\n',
      );
      expect(inferBuildTarget(dir)).toBe('//App');
    });
  });

  describe('detectBazelMajorVersion', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bazelver-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test.each([
      ['8.4.2', 8],
      ['9.x', 9],
      ['9.1.1', 9],
      ['7.0.0\n', 7],
    ])('parses %p as major %p', (contents, expected) => {
      fs.writeFileSync(path.join(dir, '.bazelversion'), contents);
      expect(detectBazelMajorVersion(dir)).toBe(expected);
    });

    test('returns null when .bazelversion is absent', () => {
      expect(detectBazelMajorVersion(dir)).toBeNull();
    });

    test('returns null when the first line has no leading integer', () => {
      fs.writeFileSync(path.join(dir, '.bazelversion'), 'latest\n');
      expect(detectBazelMajorVersion(dir)).toBeNull();
    });
  });

  test('renderLimrunBazelrc scopes every flag under the limrun config', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    // Every flag is config-scoped; the trailing user-override try-import is a
    // directive, not a flag, so it is excluded from this check.
    const flagLines = rc.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('try-import '));
    expect(flagLines.length).toBeGreaterThan(0);
    for (const line of flagLines) {
      expect(line).toMatch(/^build:limrun /);
    }
    expect(rc).toContain('--remote_executor=grpc://127.0.0.1:9123');
    expect(rc).toContain('--xcode_version_config=//.limrun:remote_xcode_config');
  });

  test('renderLimrunBazelrc pins --xcode_version to the short alias', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    expect(rc).toContain('--xcode_version=26.4');
    expect(rc).not.toContain('--xcode_version=26.4.0.17E192');
  });

  test('renderLimrunBazelrc pins the arm64 iOS simulator (the fleet is Apple Silicon)', () => {
    // Without this the app's cpu follows the client default (x86_64 on Intel/Linux)
    // and won't launch on the arm64 fleet simulator. Pinned on both client kinds.
    for (const isMac of [true, false]) {
      const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', isMac, '/ws/.limrun/bep.json', BES_URL);
      expect(rc).toContain('--ios_multi_cpus=sim_arm64');
    }
  });

  test('renderLimrunBazelrc overrides per-mnemonic strategies and completes the PATH', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    // rules_swift defaults SwiftCompile to a local worker; repos pin Genrule
    // standalone. Both must be forced remote or RBE breaks.
    expect(rc).toContain('--strategy=SwiftCompile=remote');
    expect(rc).toContain('--strategy=Genrule=remote');
    // sysctl (hw.logicalcpu) lives in /usr/sbin.
    expect(rc).toContain('--action_env=PATH=/usr/bin:/bin:/usr/sbin:/sbin');
  });

  test('renderLimrunBazelrc strips rules_apple no-remote tags so every action can run remotely', () => {
    // Under --config=limrun everything runs remotely; rules_apple's no-remote /
    // no-remote-exec tags would otherwise leave bundling/linking/signing with no
    // usable strategy. Stripped on both client kinds (the config forces remote
    // for mac too).
    for (const isMac of [true, false]) {
      const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', isMac, '/ws/.limrun/bep.json', BES_URL);
      expect(rc).toContain('--modify_execution_info=.*=-no-remote,.*=-no-remote-exec');
    }
  });

  test('renderLimrunBazelrc clears a workspace remote_cache so the executor CAS is the cache', () => {
    // A repo-level --remote_cache (e.g. BuildBuddy) alongside limrun's executor
    // splits the CAS and breaks the build ("Lost inputs"). Emptied under
    // --config=limrun on both client kinds; the executor carries its own CAS.
    for (const isMac of [true, false]) {
      const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', isMac, '/ws/.limrun/bep.json', BES_URL);
      expect(rc).toContain('build:limrun --remote_cache=\n');
    }
  });

  test('renderLimrunBazelrc try-imports a user override file last so overrides win', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    expect(rc).toContain('try-import %workspace%/user.limrun.bazelrc');
    const lines = rc.split('\n');
    const lastFlag = lines.map((l) => l.startsWith('build:limrun')).lastIndexOf(true);
    const userImport = lines.findIndex((l) => l.startsWith('try-import %workspace%/user.limrun.bazelrc'));
    expect(userImport).toBeGreaterThan(lastFlag);
  });

  test('renderLimrunBazelrc keeps outputs in CAS and emits BEP for the install verb', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    // minimal download keeps the .ipa in the instance CAS (server-side install);
    // users add --remote_download_outputs=toplevel on the command line to override.
    expect(rc).toContain('--remote_download_outputs=minimal');
    // BEP at a fixed path so `lim xcode rbe install` can read the .ipa digest.
    // Absolute path (not %workspace%, which Bazel doesn't expand in flag values).
    expect(rc).toContain('--build_event_json_file=/ws/.limrun/bep.json');
  });

  test('renderLimrunBazelrc registers a darwin exec platform only for non-mac clients', () => {
    const macRc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    const linuxRc = renderLimrunBazelrc(9123, '26.4.0.17E192', false, '/ws/.limrun/bep.json', BES_URL);
    // On a mac the flag pulls exec-config actions onto the local host, so omit it.
    expect(macRc).not.toContain('--extra_execution_platforms');
    // A Linux client has no auto-detected darwin exec platform, so it needs one.
    expect(linuxRc).toContain(
      '--extra_execution_platforms=@build_bazel_apple_support//platforms:darwin_arm64',
    );
  });

  test('renderLimrunBazelrc streams BES to the same port as the executor, non-blocking', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true, '/ws/.limrun/bep.json', BES_URL);
    // BES is co-hosted on the executor frontend, so it shares the tunnel port.
    expect(rc).toContain('build:limrun --bes_backend=grpc://127.0.0.1:9123');
    // Passed through verbatim: bazel appends the invocation id to it.
    expect(rc).toContain(`build:limrun --bes_results_url=${BES_URL}`);
    // Non-blocking upload with a bounded timeout so a slow/absent BES (e.g. an
    // older daemon image) never stalls or hangs the build.
    expect(rc).toContain('build:limrun --bes_upload_mode=nowait_for_upload_complete');
    expect(rc).toContain('build:limrun --bes_timeout=60s');
  });

  describe('filesystem effects', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbe-ws-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('writeRbeWorkspaceFiles creates the package, fragment, self-gitignore and try-import', () => {
      const result = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980, BES_URL);
      expect(fs.readFileSync(result.buildFile, 'utf8')).toContain('26.4.0.17E192');
      expect(fs.readFileSync(result.bazelrcFragment, 'utf8')).toContain('build:limrun');
      expect(fs.readFileSync(path.join(dir, '.limrun', '.gitignore'), 'utf8')).toBe('*\n');
      expect(fs.readFileSync(path.join(dir, '.bazelrc'), 'utf8')).toContain(TRY_IMPORT_LINE);
      expect(result.bazelrcUpdated).toBe(true);
      // BEP path is the ABSOLUTE workspace path, not %workspace%. Bazel does not
      // expand %workspace% in flag values, so it must not appear in any flag line
      // (it is valid only in the trailing user-override try-import directive).
      const rc = fs.readFileSync(result.bazelrcFragment, 'utf8');
      expect(rc).toContain(`--build_event_json_file=${path.join(dir, '.limrun', 'bep.json')}`);
      for (const line of rc.split('\n').filter((l) => l.startsWith('build:limrun'))) {
        expect(line).not.toContain('%workspace%');
      }
      expect(rc).toContain('try-import %workspace%/user.limrun.bazelrc');
    });

    test('writeRbeWorkspaceFiles honors a custom bep path and creates its parent dir', () => {
      const customBep = path.join(dir, 'out', 'events', 'bep.json');
      const result = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980, BES_URL, customBep);
      const rc = fs.readFileSync(result.bazelrcFragment, 'utf8');
      expect(rc).toContain(`--build_event_json_file=${customBep}`);
      expect(rc).not.toContain(path.join(dir, '.limrun', 'bep.json'));
      // The parent of a custom path is created so bazel can write there.
      expect(fs.existsSync(path.dirname(customBep))).toBe(true);
    });

    test('writeRbeWorkspaceFiles emits apple_support loads only on Bazel 9+ (per .bazelversion)', () => {
      fs.writeFileSync(path.join(dir, '.bazelversion'), '9.1.1\n');
      const r9 = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980, BES_URL);
      expect(fs.readFileSync(r9.buildFile, 'utf8')).toContain(APPLE_SUPPORT_LOADS[0]);

      fs.writeFileSync(path.join(dir, '.bazelversion'), '8.4.2\n');
      const r8 = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980, BES_URL);
      expect(fs.readFileSync(r8.buildFile, 'utf8')).not.toContain('load(');
    });

    test('ensureTryImport is idempotent and preserves existing content', () => {
      const bazelrc = path.join(dir, '.bazelrc');
      fs.writeFileSync(bazelrc, 'build --disk_cache=~/.cache/bazel\n');
      expect(ensureTryImport(dir)).toBe(true);
      const after = fs.readFileSync(bazelrc, 'utf8');
      expect(after).toContain('build --disk_cache=~/.cache/bazel');
      expect(after).toContain(TRY_IMPORT_LINE);
      expect(ensureTryImport(dir)).toBe(false);
      expect(fs.readFileSync(bazelrc, 'utf8')).toBe(after);
    });

    test('ensureTryImport ignores a commented-out occurrence and wires the active line', () => {
      const bazelrc = path.join(dir, '.bazelrc');
      // A user disabled it by commenting it out; we must still wire an active line.
      fs.writeFileSync(bazelrc, `# ${TRY_IMPORT_LINE}\n`);
      expect(ensureTryImport(dir)).toBe(true);
      const after = fs.readFileSync(bazelrc, 'utf8');
      expect(after.split('\n').some((l) => l.trim() === TRY_IMPORT_LINE)).toBe(true);
      // Now that an active line exists, it is idempotent.
      expect(ensureTryImport(dir)).toBe(false);
    });

    test('regeneration overwrites with a new fleet version', () => {
      writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980, BES_URL);
      const result = writeRbeWorkspaceFiles(dir, '26.5.0.17F42', 8980, BES_URL);
      const build = fs.readFileSync(result.buildFile, 'utf8');
      expect(build).toContain('26.5.0.17F42');
      expect(build).not.toContain('26.4.0.17E192');
      expect(result.bazelrcUpdated).toBe(false);
    });
  });
});
