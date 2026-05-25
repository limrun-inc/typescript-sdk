import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applySkillDirectoryCopy,
  planSkillDirectoryCopy,
} from '../packages/cli/src/lib/skills';
import { loadRemoteSkills } from '../packages/cli/src/lib/remote-skills';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-skills-test-'));
}

describe('remote Limrun skills source', () => {
  test('loads catalog order, frontmatter descriptions, and skill files from GitHub responses', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/limrun-inc/skills/commits/main') {
        return Response.json({ sha: 'abc123' });
      }
      if (url === 'https://api.github.com/repos/limrun-inc/skills/git/trees/abc123?recursive=1') {
        return Response.json({
          tree: [
            { path: 'catalog.json', type: 'blob' },
            { path: 'skills/limrun-xcode-and-ios-simulator/SKILL.md', type: 'blob' },
            { path: 'skills/limrun-xcode-and-ios-simulator/reference.txt', type: 'blob' },
            { path: 'skills/limrun-expo-development/SKILL.md', type: 'blob' },
            { path: 'skills/limrun-detox-testing/SKILL.md', type: 'blob' },
          ],
        });
      }
      if (url === 'https://raw.githubusercontent.com/limrun-inc/skills/abc123/catalog.json') {
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            skills: [
              { name: 'limrun-xcode-and-ios-simulator', defaultSelected: true },
              { name: 'limrun-expo-development', defaultSelected: false },
              { name: 'limrun-detox-testing', defaultSelected: false },
            ],
          }),
        );
      }
      if (
        url ===
        'https://raw.githubusercontent.com/limrun-inc/skills/abc123/skills/limrun-xcode-and-ios-simulator/SKILL.md'
      ) {
        return new Response(`---
name: limrun-xcode-and-ios-simulator
description: Build and run iOS apps remotely.
---

# iOS
`);
      }
      if (
        url ===
        'https://raw.githubusercontent.com/limrun-inc/skills/abc123/skills/limrun-xcode-and-ios-simulator/reference.txt'
      ) {
        return new Response('supporting file');
      }
      if (
        url ===
        'https://raw.githubusercontent.com/limrun-inc/skills/abc123/skills/limrun-expo-development/SKILL.md'
      ) {
        return new Response(`---
name: limrun-expo-development
description: Develop Expo apps on Limrun.
---

# Expo
`);
      }
      if (
        url === 'https://raw.githubusercontent.com/limrun-inc/skills/abc123/skills/limrun-detox-testing/SKILL.md'
      ) {
        return new Response(`---
name: limrun-detox-testing
description: Run Detox on Limrun.
---

# Detox
`);
      }
      return new Response(`unexpected ${url}`, { status: 404 });
    };

    const source = await loadRemoteSkills({ fetchImpl });
    try {
      expect(source.commit).toBe('abc123');
      expect(source.skills.map((skill) => skill.name)).toEqual([
        'limrun-xcode-and-ios-simulator',
        'limrun-expo-development',
        'limrun-detox-testing',
      ]);
      expect(source.skills[0]).toMatchObject({
        description: 'Build and run iOS apps remotely.',
        defaultSelected: true,
      });
      expect(
        fs.readFileSync(
          path.join(source.skillsRoot, 'limrun-xcode-and-ios-simulator', 'reference.txt'),
          'utf8',
        ),
      ).toBe('supporting file');
    } finally {
      source.cleanup();
    }
    expect(fs.existsSync(source.rootDir)).toBe(false);
  });

  test('surfaces GitHub rate limit failures clearly', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('rate limited', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1893456000',
        },
      });

    await expect(loadRemoteSkills({ fetchImpl })).rejects.toThrow('GitHub API rate limit exhausted');
  });
});

describe('skill directory copy planning', () => {
  test('copies whole skill directories and compares supporting files', () => {
    const tempDir = makeTempDir();
    try {
      const sourceDir = path.join(tempDir, 'source-skill');
      const targetDir = path.join(tempDir, 'target-skill');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Skill\n');
      fs.mkdirSync(path.join(sourceDir, 'references'));
      fs.writeFileSync(path.join(sourceDir, 'references', 'example.txt'), 'example');

      expect(planSkillDirectoryCopy(sourceDir, targetDir)).toEqual({ kind: 'install' });
      applySkillDirectoryCopy(sourceDir, targetDir);
      expect(fs.readFileSync(path.join(targetDir, 'references', 'example.txt'), 'utf8')).toBe('example');
      expect(planSkillDirectoryCopy(sourceDir, targetDir)).toEqual({ kind: 'unchanged' });

      fs.writeFileSync(path.join(targetDir, 'extra.txt'), 'stale');
      expect(planSkillDirectoryCopy(sourceDir, targetDir)).toEqual({ kind: 'conflict' });
      applySkillDirectoryCopy(sourceDir, targetDir);
      expect(fs.existsSync(path.join(targetDir, 'extra.txt'))).toBe(false);
      expect(planSkillDirectoryCopy(sourceDir, targetDir)).toEqual({ kind: 'unchanged' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
