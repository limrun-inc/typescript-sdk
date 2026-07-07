import fs from 'fs';
import os from 'os';
import path from 'path';
import { readRepoConfig } from '../packages/cli/src/lib/repo-config';

function writeFixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-repo-config-'));
  fs.writeFileSync(path.join(dir, 'limrun.yaml'), content);
  return dir;
}

describe('readRepoConfig', () => {
  test('returns undefined when limrun.yaml is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-repo-config-'));
    expect(readRepoConfig(dir)).toBeUndefined();
  });

  test('parses project, scheme, and prepare', () => {
    const dir = writeFixture(
      [
        'project: ios/SampleApp.xcodeproj',
        'scheme: SampleApp',
        'prepare:',
        '  - make layers',
        '  - xcodegen generate',
      ].join('\n'),
    );
    expect(readRepoConfig(dir)).toEqual({
      project: 'ios/SampleApp.xcodeproj',
      scheme: 'SampleApp',
      prepare: ['make layers', 'xcodegen generate'],
    });
  });

  test('ignores unknown keys for forward compatibility', () => {
    const dir = writeFixture('scheme: App\nfutureKnob: whatever\n');
    expect(readRepoConfig(dir)).toEqual({ scheme: 'App' });
  });

  test('rejects non-list prepare', () => {
    const dir = writeFixture('prepare: make layers\n');
    expect(() => readRepoConfig(dir)).toThrow("limrun.yaml: 'prepare' must be a list of non-empty strings");
  });

  test('rejects empty prepare entries', () => {
    const dir = writeFixture('prepare:\n  - make layers\n  - ""\n');
    expect(() => readRepoConfig(dir)).toThrow("limrun.yaml: 'prepare' must be a list of non-empty strings");
  });

  test('rejects non-string scheme', () => {
    const dir = writeFixture('scheme: [a, b]\n');
    expect(() => readRepoConfig(dir)).toThrow("limrun.yaml: 'scheme' must be a non-empty string");
  });

  test('rejects project and workspace together', () => {
    const dir = writeFixture('project: A.xcodeproj\nworkspace: A.xcworkspace\n');
    expect(() => readRepoConfig(dir)).toThrow("limrun.yaml: set either 'project' or 'workspace', not both");
  });

  test('rejects a non-mapping document', () => {
    const dir = writeFixture('- just\n- a\n- list\n');
    expect(() => readRepoConfig(dir)).toThrow('limrun.yaml: expected a mapping of configuration keys');
  });
});
