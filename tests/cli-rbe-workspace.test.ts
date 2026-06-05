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
    const build = renderXcodeConfigBuild('26.4.0.17E192');
    expect(build).toContain('version = "26.4.0.17E192"');
    expect(build).toContain('default_ios_sdk_version = "26.4"');
    expect(build).toContain('"26.4",');
    expect(build).toContain('"26.4.0",');
    expect(build).toContain('name = "remote_xcode_config"');
  });

  test('renderXcodeConfigBuild rejects malformed version keys', () => {
    expect(() => renderXcodeConfigBuild('26')).toThrow(/unexpected Xcode version key/);
  });

  test('renderLimrunBazelrc scopes every flag under the limrun config', () => {
    const rc = renderLimrunBazelrc(9123);
    const flagLines = rc.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(flagLines.length).toBeGreaterThan(0);
    for (const line of flagLines) {
      expect(line).toMatch(/^build:limrun /);
    }
    expect(rc).toContain('--remote_executor=grpc://127.0.0.1:9123');
    expect(rc).toContain('--xcode_version_config=//.limrun:remote_xcode_config');
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
