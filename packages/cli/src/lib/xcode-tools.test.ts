import { NotFoundError } from '@limrun/api';
import { EventEmitter } from 'events';
import { BaseCommand } from '../base-command';

jest.mock('./daemon', () => ({ ...jest.requireActual('./daemon'), stopDaemon: jest.fn() }));
jest.mock('./config', () => ({ ...jest.requireActual('./config'), clearLastInstanceId: jest.fn() }));
import { Parser } from '@oclif/core';
import XcodeUse from '../commands/xcode/use';
import XcodeTools from '../commands/xcode/tools';
import GradleUse from '../commands/gradle/use';
import GradleTools from '../commands/gradle/tools';
import GradleRun from '../commands/gradle/run';

it('parses multiple tool requests alongside scope flags', async () => {
  const result = await Parser.parse(['--global', '--cwd', 'apps/mobile', 'node@24', 'ruby@3.3'], {
    flags: XcodeUse.flags,
    args: XcodeUse.args,
    strict: XcodeUse.strict,
  });
  expect(result.argv).toEqual(['node@24', 'ruby@3.3']);
  expect(result.flags.global).toBe(true);
  expect(result.flags.cwd).toBe('apps/mobile');
});

it('supports inspecting an existing workspace without sync', async () => {
  const result = await Parser.parse(['--cwd', 'apps/mobile'], { flags: XcodeTools.flags });
  expect(result.flags.sync).toBe(false);
  expect(result.flags.cwd).toBe('apps/mobile');
});

it('gives Gradle the same tool-selection flags and Java vendor support', async () => {
  const result = await Parser.parse(['--global', 'java@temurin-17', 'node@24'], {
    flags: GradleUse.flags,
    args: GradleUse.args,
    strict: GradleUse.strict,
  });
  expect(result.argv).toEqual(['java@temurin-17', 'node@24']);
  expect(result.flags.global).toBe(true);
  expect(Object.keys(GradleTools.flags)).toEqual(Object.keys(XcodeTools.flags));
  expect(GradleRun.examples?.[0]).toContain('gradle run');
});

it.each([XcodeTools, GradleTools])('syncs tool inspection only when requested', async (Tools) => {
  for (const sync of [false, true]) {
    const proc = Object.assign(Promise.resolve({ exitCode: 0 }), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const client = { sync: jest.fn().mockResolvedValue({}), run: jest.fn().mockReturnValue(proc) };
    const resolve = jest.fn().mockResolvedValue({ client });
    const command = new (Tools as unknown as new (argv: string[], config: never) => BaseCommand)(
      [],
      {} as never,
    );
    Object.assign(command, {
      parse: async () => ({ flags: { sync, cwd: 'apps/mobile' } }),
      setParsedFlags: jest.fn(),
      withAuth: async (fn: () => Promise<void>) => fn(),
      resolveBuildToolClient: resolve,
      info: jest.fn(),
    });
    await command.run();
    expect(resolve).toHaveBeenCalledWith(Tools === XcodeTools ? 'xcode' : 'gradle', undefined, 'existing');
    expect(client.sync).toHaveBeenCalledTimes(sync ? 1 : 0);
    expect(client.run).toHaveBeenCalledWith('mise ls --current', { cwd: 'apps/mobile' });
  }
});

class InspectionCommand extends BaseCommand {
  runWithAuth(fn: () => Promise<void>) {
    return this.withAuth(fn);
  }
  async run(): Promise<void> {}
  inspect(platform: 'xcode' | 'gradle') {
    return this.resolveBuildToolClient(platform, undefined, 'existing');
  }
}

it.each(['xcode', 'gradle'] as const)(
  'does not create or reconfigure a %s sandbox during inspection',
  async (platform) => {
    const command = new InspectionCommand([], {} as never);
    const target = { id: 'existing' };
    const create = jest.fn();
    const configure = jest.fn();
    Object.assign(command, {
      resolveXcodeTarget: jest.fn().mockResolvedValue(target),
      resolveGradleTarget: jest.fn().mockReturnValue(target),
      resolveXcodeTargetOrCreate: create,
      resolveGradleTargetOrCreate: create,
      resolveXcodeClient: jest.fn().mockResolvedValue('client'),
      resolveGradleClient: jest.fn().mockResolvedValue('client'),
      resolveXcodeClientForWork: configure,
    });
    expect(await command.inspect(platform)).toEqual({ target, client: 'client' });
    expect(create).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  },
);

it.each(['xcode', 'gradle'])(
  'does not replace a missing %s sandbox during tool inspection',
  async (platform) => {
    const command = new InspectionCommand([], {} as never);
    const replace = jest.fn();
    Object.assign(command, {
      getCommandParts: () => [platform, 'tools'],
      _lastResolvedInstanceId: 'missing',
      createReplacementInstance: replace,
    });
    await expect(
      command.runWithAuth(async () => {
        throw new NotFoundError(404, { message: 'missing' }, undefined, new Headers());
      }),
    ).rejects.toThrow('was not found');
    expect(replace).not.toHaveBeenCalled();
  },
);

it.each([XcodeTools, GradleTools])('accepts explicit --sync for tool inspection', async (Tools) => {
  expect((await Parser.parse(['--sync'], { flags: Tools.flags })).flags.sync).toBe(true);
});
