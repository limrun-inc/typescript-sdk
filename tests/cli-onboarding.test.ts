import fs from 'fs';
import os from 'os';
import path from 'path';

import { detectProject } from '../packages/cli/src/lib/project-detection';
import {
  ensureSampleRepo,
  installProjectSkills,
  SAMPLE_NATIVE_APP_DIR,
  SAMPLE_NATIVE_APP_REPO,
  verifySampleAgentPaths,
} from '../packages/cli/src/lib/onboarding';
import type { LoadedRemoteSkills } from '../packages/cli/src/lib/remote-skills';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-onboarding-test-'));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeSkillSource(root: string, name: string, content = 'skill'): string {
  const skillDir = path.join(root, 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
  return skillDir;
}

function fakeRemoteSkills(root: string, names: string[]): LoadedRemoteSkills {
  return {
    owner: 'limrun-inc',
    repo: 'skills',
    ref: 'main',
    commit: 'test',
    rootDir: root,
    skillsRoot: path.join(root, 'skills'),
    skills: names.map((name) => ({
      name,
      description: name,
      defaultSelected: false,
      sourceDir: makeSkillSource(root, name, name),
    })),
    cleanup: jest.fn(),
  };
}

describe('lim go project detection', () => {
  test('detects one native iOS app directory with project and workspace files', () => {
    const root = makeTempDir();
    try {
      fs.mkdirSync(path.join(root, 'App.xcodeproj'), { recursive: true });
      fs.mkdirSync(path.join(root, 'App.xcworkspace'), { recursive: true });

      expect(detectProject(root)).toMatchObject({
        kind: 'native-ios',
        projectDir: root,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects Expo apps, including prebuilt apps with nested ios projects', () => {
    const root = makeTempDir();
    try {
      writeFile(
        path.join(root, 'apps', 'mobile', 'package.json'),
        JSON.stringify({ dependencies: { expo: '~54.0.0' } }),
      );
      writeFile(path.join(root, 'apps', 'mobile', 'app.config.ts'), 'export default {};');
      fs.mkdirSync(path.join(root, 'apps', 'mobile', 'ios', 'Mobile.xcodeproj'), { recursive: true });

      expect(detectProject(root)).toMatchObject({
        kind: 'expo',
        projectDir: path.join(root, 'apps', 'mobile'),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('falls back to sample for ambiguous or unsupported directories', () => {
    const root = makeTempDir();
    try {
      fs.mkdirSync(path.join(root, 'apps', 'one', 'One.xcodeproj'), { recursive: true });
      fs.mkdirSync(path.join(root, 'apps', 'two', 'Two.xcodeproj'), { recursive: true });
      expect(detectProject(root)).toEqual({ kind: 'sample' });

      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'android'), { recursive: true });
      writeFile(path.join(root, 'settings.gradle'), 'pluginManagement {}');
      expect(detectProject(root)).toEqual({ kind: 'sample' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('lim go skill installation', () => {
  test('installs selected skills into project-local agents and skips divergent conflicts', async () => {
    const projectRoot = makeTempDir();
    const sourceRoot = makeTempDir();
    try {
      const source = fakeRemoteSkills(sourceRoot, ['limrun-xcode-and-ios-simulator']);
      writeFile(
        path.join(projectRoot, '.claude', 'skills', 'limrun-xcode-and-ios-simulator', 'SKILL.md'),
        'local changes',
      );

      const results = await installProjectSkills({
        projectRoot,
        skillNames: ['limrun-xcode-and-ios-simulator'],
        source,
      });

      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent: 'cursor', status: 'installed' }),
          expect.objectContaining({ agent: 'claude', status: 'skipped' }),
        ]),
      );
      expect(
        fs.readFileSync(
          path.join(projectRoot, '.agents', 'skills', 'limrun-xcode-and-ios-simulator', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('limrun-xcode-and-ios-simulator');
      expect(
        fs.readFileSync(
          path.join(projectRoot, '.claude', 'skills', 'limrun-xcode-and-ios-simulator', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('local changes');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

describe('lim go sample repo handling', () => {
  test('clones missing sample dir with the expected repository', async () => {
    const root = makeTempDir();
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    try {
      const sample = await ensureSampleRepo({
        cwd: root,
        git: async (args, cwd) => {
          calls.push({ args, cwd });
          return '';
        },
      });

      expect(sample).toEqual({ path: path.join(root, SAMPLE_NATIVE_APP_DIR), reused: false });
      expect(calls).toEqual([
        {
          args: ['clone', '--depth', '1', SAMPLE_NATIVE_APP_REPO, SAMPLE_NATIVE_APP_DIR],
          cwd: root,
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reuses existing sample dir only when origin matches', async () => {
    const root = makeTempDir();
    try {
      fs.mkdirSync(path.join(root, SAMPLE_NATIVE_APP_DIR), { recursive: true });

      await expect(
        ensureSampleRepo({
          cwd: root,
          git: async () => `${SAMPLE_NATIVE_APP_REPO}.git`,
        }),
      ).resolves.toEqual({ path: path.join(root, SAMPLE_NATIVE_APP_DIR), reused: true });

      await expect(
        ensureSampleRepo({
          cwd: root,
          git: async () => 'ssh://git@github.com/limrun-inc/sample-native-app',
        }),
      ).resolves.toEqual({ path: path.join(root, SAMPLE_NATIVE_APP_DIR), reused: true });

      await expect(
        ensureSampleRepo({
          cwd: root,
          git: async () => 'https://github.com/example/not-the-sample.git',
        }),
      ).rejects.toThrow('already exists with origin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports unavailable sample agent paths', () => {
    const root = makeTempDir();
    try {
      const sampleDir = path.join(root, SAMPLE_NATIVE_APP_DIR);
      fs.mkdirSync(path.join(sampleDir, '.agents', 'skills', 'xcode-and-simulator'), { recursive: true });
      expect(verifySampleAgentPaths(sampleDir)).toEqual([
        path.join('.claude', 'skills', 'xcode-and-simulator'),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
