import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { installProjectSkills } from './onboarding';
import { type LoadedRemoteSkills } from './remote-skills';
import { type TelemetryCapture } from './telemetry';

describe('onboarding skills telemetry', () => {
  let tempDir: string;
  let projectRoot: string;
  let sourceDir: string;
  let source: LoadedRemoteSkills;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-onboarding-telemetry-'));
    projectRoot = path.join(tempDir, 'project');
    sourceDir = path.join(tempDir, 'source', 'limrun-xcode');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), '# Limrun Xcode\n');
    source = {
      owner: 'limrun-inc',
      repo: 'skills',
      ref: 'main',
      commit: 'abc123',
      rootDir: path.join(tempDir, 'source'),
      skillsRoot: path.join(tempDir, 'source'),
      skills: [
        {
          name: 'limrun-xcode',
          description: 'Build with Xcode',
          defaultSelected: true,
          sourceDir,
        },
      ],
      cleanup: jest.fn(),
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('records start and success with counts only', async () => {
    const telemetry = jest
      .fn<ReturnType<TelemetryCapture>, Parameters<TelemetryCapture>>()
      .mockResolvedValue(true);

    const results = await installProjectSkills({
      projectRoot,
      skillNames: ['limrun-xcode'],
      source,
      telemetry,
    });

    expect(results).toHaveLength(2);
    expect(telemetry).toHaveBeenNthCalledWith(1, 'skills_install_started', {
      entrypoint: 'onboarding',
      skill_count: 1,
      agent_count: 2,
    });
    expect(telemetry).toHaveBeenNthCalledWith(2, 'skills_install_succeeded', {
      entrypoint: 'onboarding',
      skill_count: 1,
      agent_count: 2,
      installed_count: 2,
      updated_count: 0,
      unchanged_count: 0,
    });
  });

  it('records a categorized failure without exposing the missing skill name', async () => {
    const telemetry = jest
      .fn<ReturnType<TelemetryCapture>, Parameters<TelemetryCapture>>()
      .mockResolvedValue(true);

    await expect(
      installProjectSkills({
        projectRoot,
        skillNames: ['private-skill-name'],
        source,
        telemetry,
      }),
    ).rejects.toThrow('private-skill-name');

    expect(telemetry).toHaveBeenNthCalledWith(2, 'skills_install_failed', {
      entrypoint: 'onboarding',
      skill_count: 1,
      agent_count: 2,
      error_category: 'unknown',
    });
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain('private-skill-name');
  });
});
