import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { detectProject } from '../packages/cli/src/lib/project-detection';
import {
  applyProjectEnvApiKey,
  ensureSampleRepo,
  ensureProjectEnvApiKey,
  installProjectSkills,
  SAMPLE_NATIVE_APP_DIR,
  SAMPLE_NATIVE_APP_REPO,
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
  test('detects a default Xcode native iOS app without counting bundle internals', () => {
    const root = makeTempDir();
    try {
      writeFile(path.join(root, 'App.xcodeproj', 'project.pbxproj'), '');
      writeFile(path.join(root, 'App.xcodeproj', 'project.xcworkspace', 'contents.xcworkspacedata'), '');
      writeFile(path.join(root, 'App', 'ContentView.swift'), '');

      expect(detectProject(root)).toMatchObject({
        kind: 'native-ios',
        projectDir: root,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects native iOS apps in a conventional ios directory', () => {
    const root = makeTempDir();
    try {
      writeFile(path.join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'), '');
      writeFile(path.join(root, 'ios', 'App', 'ContentView.swift'), '');

      expect(detectProject(root)).toMatchObject({
        kind: 'native-ios',
        projectDir: path.join(root, 'ios'),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('prefers a root iOS app when nested stale sample projects also exist', () => {
    const root = makeTempDir();
    try {
      writeFile(path.join(root, 'App.xcodeproj', 'project.pbxproj'), '');
      writeFile(path.join(root, 'App', 'ContentView.swift'), '');
      writeFile(path.join(root, 'sample-native-app', 'sample-native-app.xcodeproj', 'project.pbxproj'), '');

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

describe('lim go project env setup', () => {
  const originalApiKey = process.env['LIM_API_KEY'];

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env['LIM_API_KEY'];
    } else {
      process.env['LIM_API_KEY'] = originalApiKey;
    }
  });

  test('loads LIM_API_KEY from project .env.local before login', () => {
    const projectRoot = makeTempDir();
    try {
      delete process.env['LIM_API_KEY'];
      writeFile(path.join(projectRoot, '.env'), 'LIM_API_KEY=lim_env_key\n');
      writeFile(path.join(projectRoot, '.env.local'), 'LIM_API_KEY=lim_local_key\n');

      expect(applyProjectEnvApiKey(projectRoot)).toEqual({
        apiKey: 'lim_local_key',
        path: path.join(projectRoot, '.env.local'),
      });
      expect(process.env['LIM_API_KEY']).toBe('lim_local_key');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('does not override an explicit process LIM_API_KEY with project env files', () => {
    const projectRoot = makeTempDir();
    try {
      process.env['LIM_API_KEY'] = 'lim_shell_key';
      writeFile(path.join(projectRoot, '.env.local'), 'LIM_API_KEY=lim_local_key\n');

      expect(applyProjectEnvApiKey(projectRoot).apiKey).toBe('lim_local_key');
      expect(process.env['LIM_API_KEY']).toBe('lim_shell_key');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('lets .env.local override a .env value loaded by dotenv/config', () => {
    const projectRoot = makeTempDir();
    try {
      process.env['LIM_API_KEY'] = 'lim_env_key';
      writeFile(path.join(projectRoot, '.env'), 'LIM_API_KEY=lim_env_key\n');
      writeFile(path.join(projectRoot, '.env.local'), 'LIM_API_KEY=lim_local_key\n');

      applyProjectEnvApiKey(projectRoot);

      expect(process.env['LIM_API_KEY']).toBe('lim_local_key');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('creates missing .env with LIM_API_KEY using private file mode', () => {
    const projectRoot = makeTempDir();
    try {
      ensureProjectEnvApiKey(projectRoot, 'lim_test_key');

      const envPath = path.join(projectRoot, '.env');
      expect(fs.readFileSync(envPath, 'utf8')).toBe('LIM_API_KEY=lim_test_key\n');
      expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('appends LIM_API_KEY to existing .env without clobbering variables', () => {
    const projectRoot = makeTempDir();
    try {
      writeFile(path.join(projectRoot, '.env'), 'EXISTING=value');
      fs.chmodSync(path.join(projectRoot, '.env'), 0o644);

      ensureProjectEnvApiKey(projectRoot, 'lim_test_key');

      expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toBe(
        'EXISTING=value\nLIM_API_KEY=lim_test_key',
      );
      expect(fs.statSync(path.join(projectRoot, '.env')).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('replaces existing LIM_API_KEY variants without duplicating them', () => {
    const projectRoot = makeTempDir();
    try {
      writeFile(
        path.join(projectRoot, '.env'),
        ['A=1', 'export LIM_API_KEY=old', 'B=2', 'LIM_API_KEY=older', ''].join('\n'),
      );

      ensureProjectEnvApiKey(projectRoot, 'lim_new_key');

      expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toBe(
        ['A=1', 'LIM_API_KEY=lim_new_key', 'B=2', ''].join('\n'),
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('rejects symlinked .env files before writing API keys', () => {
    const projectRoot = makeTempDir();
    try {
      fs.symlinkSync(path.join(projectRoot, 'outside-env'), path.join(projectRoot, '.env'));

      expect(() => ensureProjectEnvApiKey(projectRoot, 'lim_test_key')).toThrow('not a regular file');
      expect(fs.existsSync(path.join(projectRoot, 'outside-env'))).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('refuses to write LIM_API_KEY into git-tracked .env files', () => {
    const projectRoot = makeTempDir();
    try {
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
      writeFile(path.join(projectRoot, '.env'), 'EXISTING=value');
      execFileSync('git', ['add', '.env'], { cwd: projectRoot, stdio: 'ignore' });

      expect(() => ensureProjectEnvApiKey(projectRoot, 'lim_test_key')).toThrow('tracked by git');
      expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toBe('EXISTING=value');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test('warns when .env is not ignored by git', () => {
    const projectRoot = makeTempDir();
    try {
      execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });

      const result = ensureProjectEnvApiKey(projectRoot, 'lim_test_key');

      expect(result.warnings).toEqual([expect.stringContaining('not ignored by git')]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
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
          calls.push(cwd === undefined ? { args } : { args, cwd });
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
});
