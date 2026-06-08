import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  TRY_IMPORT_LINE,
  detectBazelMajorVersion,
  ensureTryImport,
  findBazelWorkspaceRoot,
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
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true);
    const flagLines = rc.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(flagLines.length).toBeGreaterThan(0);
    for (const line of flagLines) {
      expect(line).toMatch(/^build:limrun /);
    }
    expect(rc).toContain('--remote_executor=grpc://127.0.0.1:9123');
    expect(rc).toContain('--xcode_version_config=//.limrun:remote_xcode_config');
  });

  test('renderLimrunBazelrc pins --xcode_version to the short alias', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true);
    expect(rc).toContain('--xcode_version=26.4');
    expect(rc).not.toContain('--xcode_version=26.4.0.17E192');
  });

  test('renderLimrunBazelrc overrides per-mnemonic strategies and completes the PATH', () => {
    const rc = renderLimrunBazelrc(9123, '26.4.0.17E192', true);
    // rules_swift defaults SwiftCompile to a local worker; repos pin Genrule
    // standalone. Both must be forced remote or RBE breaks.
    expect(rc).toContain('--strategy=SwiftCompile=remote');
    expect(rc).toContain('--strategy=Genrule=remote');
    // sysctl (hw.logicalcpu) lives in /usr/sbin.
    expect(rc).toContain('--action_env=PATH=/usr/bin:/bin:/usr/sbin:/sbin');
  });

  test('renderLimrunBazelrc registers a darwin exec platform only for non-mac clients', () => {
    const macRc = renderLimrunBazelrc(9123, '26.4.0.17E192', true);
    const linuxRc = renderLimrunBazelrc(9123, '26.4.0.17E192', false);
    // On a mac the flag pulls exec-config actions onto the local host, so omit it.
    expect(macRc).not.toContain('--extra_execution_platforms');
    // A Linux client has no auto-detected darwin exec platform, so it needs one.
    expect(linuxRc).toContain('--extra_execution_platforms=@build_bazel_apple_support//platforms:darwin_arm64');
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
      const result = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980);
      expect(fs.readFileSync(result.buildFile, 'utf8')).toContain('26.4.0.17E192');
      expect(fs.readFileSync(result.bazelrcFragment, 'utf8')).toContain('build:limrun');
      expect(fs.readFileSync(path.join(dir, '.limrun', '.gitignore'), 'utf8')).toBe('*\n');
      expect(fs.readFileSync(path.join(dir, '.bazelrc'), 'utf8')).toContain(TRY_IMPORT_LINE);
      expect(result.bazelrcUpdated).toBe(true);
    });

    test('writeRbeWorkspaceFiles emits apple_support loads only on Bazel 9+ (per .bazelversion)', () => {
      fs.writeFileSync(path.join(dir, '.bazelversion'), '9.1.1\n');
      const r9 = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980);
      expect(fs.readFileSync(r9.buildFile, 'utf8')).toContain(APPLE_SUPPORT_LOADS[0]);

      fs.writeFileSync(path.join(dir, '.bazelversion'), '8.4.2\n');
      const r8 = writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980);
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
      writeRbeWorkspaceFiles(dir, '26.4.0.17E192', 8980);
      const result = writeRbeWorkspaceFiles(dir, '26.5.0.17F42', 8980);
      const build = fs.readFileSync(result.buildFile, 'utf8');
      expect(build).toContain('26.5.0.17F42');
      expect(build).not.toContain('26.4.0.17E192');
      expect(result.bazelrcUpdated).toBe(false);
    });
  });
});
