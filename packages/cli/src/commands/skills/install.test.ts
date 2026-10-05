import fs from 'fs';
import os from 'os';
import path from 'path';
import { Config } from '@oclif/core';
import SkillsInstall from './install';
import { loadRemoteSkills, type LoadedRemoteSkills } from '../../lib/remote-skills';

jest.mock('../../lib/remote-skills', () => ({ loadRemoteSkills: jest.fn() }));
jest.mock('../../lib/telemetry', () => ({ captureTelemetry: jest.fn(), telemetryErrorCategory: jest.fn() }));

describe('skills install revision flags', () => {
  let rootDir: string;
  let originalCwd: string;
  let source: LoadedRemoteSkills;
  let config: Config;

  beforeAll(async () => {
    config = await Config.load({ root: path.resolve(__dirname, '../../..') });
  });

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-skills-install-'));
    originalCwd = process.cwd();
    process.chdir(rootDir);
    const sourceDir = path.join(rootDir, 'source', 'limrun-xcode');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Pinned skill\n');
    source = {
      owner: 'limrun-inc',
      repo: 'skills',
      ref: 'refs/tags/v0.1.17',
      commit: 'a'.repeat(40),
      rootDir,
      skillsRoot: path.dirname(sourceDir),
      skills: [{ name: 'limrun-xcode', description: 'Build apps.', defaultSelected: true, sourceDir }],
      cleanup: jest.fn(),
    };
    jest.mocked(loadRemoteSkills).mockResolvedValue(source);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(rootDir, { recursive: true, force: true });
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test.each([
    [[], {}],
    [['--version', '0.1.17'], { version: '0.1.17' }],
    [['--commit', 'a'.repeat(40)], { commit: 'a'.repeat(40) }],
  ])('installs the selected source for %j and reports its commit in JSON', async (args, options) => {
    const command = new SkillsInstall([...args, '--agents', 'claude', '--json'], config);
    const log = jest.spyOn(command, 'log').mockImplementation(() => {});
    await command.run();
    expect(loadRemoteSkills).toHaveBeenCalledWith(options);
    expect(fs.readFileSync(path.join(rootDir, '.claude/skills/limrun-xcode/SKILL.md'), 'utf8')).toBe(
      '# Pinned skill\n',
    );
    expect(JSON.parse(log.mock.calls[0]![0]!)).toMatchObject({
      source: { repository: 'limrun-inc/skills', ref: source.ref, commit: source.commit },
      results: [{ skill: 'limrun-xcode', status: 'installed' }],
    });
    expect(source.cleanup).toHaveBeenCalled();
  });

  test('rejects version and commit together before fetching or installing', async () => {
    const command = new SkillsInstall(['--version', '0.1.17', '--commit', 'a'.repeat(40)], config);
    await expect(command.run()).rejects.toThrow('cannot also be provided');
    expect(loadRemoteSkills).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(rootDir, '.claude'))).toBe(false);
  });
});
