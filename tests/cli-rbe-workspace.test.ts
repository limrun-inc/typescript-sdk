import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  TRY_IMPORT_LINE,
  ensureTryImport,
  renderLimrunBazelrc,
  renderXcodeConfigBuild,
  writeRbeWorkspaceFiles,
} from '../packages/cli/src/lib/rbe-workspace';

describe('rbe workspace generation', () => {
  test('renderXcodeConfigBuild pins the fleet version and derives sdk defaults', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', '26.5.0.17F42');
    expect(build).toContain('version = "26.4.0.17E192"');
    expect(build).toContain('default_ios_sdk_version = "26.4"');
    expect(build).toContain('"26.4",');
    expect(build).toContain('"26.4.0",');
    expect(build).toContain('name = "remote_xcode_config"');
  });

  test('renderXcodeConfigBuild uses the remote/local split, never a single default bucket', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', '26.5.0.17F42');
    expect(build).toContain('name = "remote_xcodes"');
    expect(build).toContain('remote_versions = ":remote_xcodes"');
    expect(build).toContain('local_versions = ":local_xcodes"');
    // A bare default/versions xcode_config is what triggers the client-side
    // xcode-locator abort; the config must not regress to it.
    expect(build).not.toMatch(/xcode_config\([^)]*\bdefault =/);
    // The fleet version must never be referenced via the invisible bazel repo.
    expect(build).not.toContain('@local_config_xcode');
  });

  test('renderXcodeConfigBuild (distinct local Xcode) declares it as the local set', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', '26.5.0.17F42');
    // The local Xcode is its own rule so local actions resolve against 26.5...
    expect(build).toContain('name = "local_xcode"');
    expect(build).toContain('version = "26.5.0.17F42"');
    expect(build).toContain('default = ":local_xcode"');
    // ...while the fleet 26.4 stays remote-only (not in the local set).
    expect(build).toMatch(/available_xcodes\(\s*name = "local_xcodes",\s*default = ":local_xcode"/);
  });

  test('renderXcodeConfigBuild (no local Xcode) emits a synthetic local set pinned to the fleet version', () => {
    const build = renderXcodeConfigBuild('26.4.0.17E192', null);
    expect(build).not.toContain('@local_config_xcode');
    expect(build).not.toContain('name = "local_xcode"'); // no distinct local rule
    expect(build).toContain('local_versions = ":local_xcodes"');
    expect(build).toMatch(/available_xcodes\(\s*name = "local_xcodes",\s*default = ":remote_xcode"/);
  });

  test('renderXcodeConfigBuild (local matches fleet) collapses to the synthetic set', () => {
    // Same major.minor locally and remotely: no separate local_xcode rule.
    const build = renderXcodeConfigBuild('26.4.0.17E192', '26.4.0.17E192');
    expect(build).not.toContain('name = "local_xcode"');
    expect(build).toMatch(/available_xcodes\(\s*name = "local_xcodes",\s*default = ":remote_xcode"/);
  });

  test('renderXcodeConfigBuild rejects malformed version keys', () => {
    expect(() => renderXcodeConfigBuild('26', null)).toThrow(/unexpected Xcode version key/);
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
