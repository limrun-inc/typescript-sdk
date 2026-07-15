import fs from 'fs';
import os from 'os';
import path from 'path';

import { applySkillDirectoryCopy, planSkillDirectoryCopy } from '../packages/cli/src/lib/skills';
import { __remoteSkillsTestUtils, loadRemoteSkills } from '../packages/cli/src/lib/remote-skills';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-skills-test-'));
}

describe('remote Limrun skills source', () => {
  function writeSkill(rootDir: string, name: string, description: string): void {
    const skillDir = path.join(rootDir, 'skills', name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: ${name}
description: ${description}
---

# ${name}
`,
    );
  }

  function writeCatalog(rootDir: string, names: string[]): void {
    fs.writeFileSync(
      path.join(rootDir, 'catalog.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          skills: names.map((name, index) => ({ name, defaultSelected: index === 0 })),
        },
        null,
        2,
      ),
    );
  }

  test('loads catalog order, frontmatter descriptions, and skill files from a cloned checkout', async () => {
    const checkoutDir = makeTempDir();
    writeCatalog(checkoutDir, ['limrun-xcode', 'limrun-expo-development', 'limrun-detox-testing']);
    writeSkill(checkoutDir, 'limrun-xcode', 'Build iOS apps remotely.');
    fs.writeFileSync(path.join(checkoutDir, 'skills', 'limrun-xcode', 'reference.txt'), 'supporting file');
    writeSkill(checkoutDir, 'limrun-expo-development', 'Develop Expo apps on Limrun.');
    writeSkill(checkoutDir, 'limrun-detox-testing', 'Run Detox on Limrun.');

    const source = await loadRemoteSkills({
      cloneImpl: async () => ({ rootDir: checkoutDir, commit: 'abc123' }),
    });
    try {
      expect(source.commit).toBe('abc123');
      expect(source.skills.map((skill) => skill.name)).toEqual([
        'limrun-xcode',
        'limrun-expo-development',
        'limrun-detox-testing',
      ]);
      expect(source.skills[0]).toMatchObject({
        description: 'Build iOS apps remotely.',
        defaultSelected: true,
      });
      expect(fs.readFileSync(path.join(source.skillsRoot, 'limrun-xcode', 'reference.txt'), 'utf8')).toBe(
        'supporting file',
      );
    } finally {
      source.cleanup();
    }
    expect(fs.existsSync(source.rootDir)).toBe(false);
  });

  test('rejects unsafe catalog skill names', async () => {
    const checkoutDir = makeTempDir();
    try {
      writeCatalog(checkoutDir, ['../escape']);
      await expect(
        loadRemoteSkills({
          cloneImpl: async () => ({ rootDir: checkoutDir, commit: 'abc123' }),
        }),
      ).rejects.toThrow('lowercase hyphenated skill name');
    } finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true });
    }
  });

  test('refuses to clean up directories outside the temp directory', () => {
    expect(() => __remoteSkillsTestUtils.cleanupSkillsTempDir(process.cwd())).toThrow(
      'Refusing to clean up non-temporary skills directory',
    );
  });

  test('parses SKILL.md frontmatter with CRLF line endings', async () => {
    const checkoutDir = makeTempDir();
    try {
      writeCatalog(checkoutDir, ['limrun-xcode']);
      const skillDir = path.join(checkoutDir, 'skills', 'limrun-xcode');
      fs.mkdirSync(skillDir, { recursive: true });
      // Write SKILL.md using CRLF line endings throughout
      const crlfContent = [
        '---',
        'name: limrun-xcode',
        'description: Build iOS apps remotely.',
        '---',
        '',
        '# limrun-xcode',
        '',
      ].join('\r\n');
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), crlfContent);

      const source = await loadRemoteSkills({
        cloneImpl: async () => ({ rootDir: checkoutDir, commit: 'crlf01' }),
      });
      try {
        expect(source.skills[0]).toMatchObject({
          name: 'limrun-xcode',
          description: 'Build iOS apps remotely.',
        });
      } finally {
        source.cleanup();
      }
    } finally {
      fs.rmSync(checkoutDir, { recursive: true, force: true });
    }
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

  test('preserves existing target when the replacement copy fails', () => {
    const tempDir = makeTempDir();
    try {
      const sourceDir = path.join(tempDir, 'missing-source');
      const targetDir = path.join(tempDir, 'target-skill');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'SKILL.md'), 'old content');

      expect(() => applySkillDirectoryCopy(sourceDir, targetDir)).toThrow();
      expect(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('old content');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('treats symlinked target files as conflicts without following them', () => {
    const tempDir = makeTempDir();
    try {
      const sourceDir = path.join(tempDir, 'source-skill');
      const targetDir = path.join(tempDir, 'target-skill');
      const outsideDir = path.join(tempDir, 'outside');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), 'same content');
      fs.writeFileSync(path.join(outsideDir, 'external.md'), 'same content');
      fs.symlinkSync(path.join(outsideDir, 'external.md'), path.join(targetDir, 'SKILL.md'));

      expect(planSkillDirectoryCopy(sourceDir, targetDir)).toEqual({ kind: 'conflict' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('treats a symlinked target directory as a conflict', () => {
    const tempDir = makeTempDir();
    try {
      const sourceDir = path.join(tempDir, 'source-skill');
      const outsideDir = path.join(tempDir, 'outside-target');
      const targetDir = path.join(tempDir, 'target-skill');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), 'same content');
      fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), 'same content');
      fs.symlinkSync(outsideDir, targetDir, 'dir');

      expect(planSkillDirectoryCopy(sourceDir, targetDir)).toEqual({ kind: 'conflict' });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
