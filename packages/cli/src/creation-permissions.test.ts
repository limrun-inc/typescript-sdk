import { BaseCommand } from './base-command';
import IosCreate from './commands/ios/create';
import AndroidCreate from './commands/android/create';
import XcodeCreate from './commands/xcode/create';
import GradleCreate from './commands/gradle/create';
import Run from './commands/run';
import XcodeSync from './commands/xcode/sync';
import XcodeTest from './commands/xcode/test';
import GradleSync from './commands/gradle/sync';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  registerCreatedInstance: jest.fn(),
}));

const platforms = [
  [IosCreate, 'iosInstances'],
  [AndroidCreate, 'androidInstances'],
  [XcodeCreate, 'xcodeInstances'],
  [GradleCreate, 'gradleInstances'],
] as const;

describe.each(platforms)('%s create permissions', (Command, resource) => {
  test.each([
    { permissions: [], reuse: false },
    { permissions: [], reuse: true },
    { permissions: ['asset:name/fixtures/*:read'], reuse: false },
    { permissions: ['asset:name/fixtures/*:read'], reuse: true },
  ])('sends explicit grants %j', async ({ permissions, reuse }) => {
    const stop = new Error('stop after capturing create');
    const create = jest.fn().mockRejectedValue(stop);
    const command = new Command([], {} as never);
    Object.assign(command, {
      parse: async () => ({
        args: {},
        flags: {
          'reuse-if-exists': reuse,
          ...(resource === 'xcodeInstances' && { 'no-snapshot': true }),
          ...(permissions.length && { permission: permissions }),
        },
      }),
      withAuth: async (fn: () => Promise<void>) => fn(),
      info: jest.fn(),
    });
    Object.defineProperty(command, 'client', { value: { [resource]: { create } } });
    await expect(command.run()).rejects.toThrow(stop);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        reuseIfExists: !permissions.length && reuse ? true : undefined,
        spec: expect.objectContaining({ role: { permissions } }),
      }),
    );
  });
});

test.each([Run, XcodeSync, XcodeTest, GradleSync])('%s exposes creation-time permissions', (Command) => {
  expect(Command.flags.permission).toBe(BaseCommand.permissionFlags.permission);
});

test.each([
  [IosCreate, 'iosInstances', 'xcodeInstances', 'xcode'],
  [XcodeCreate, 'xcodeInstances', 'iosInstances', 'ios'],
] as const)(
  '%s keeps paired creations fresh when permissions are requested',
  async (Command, primary, secondary, flag) => {
    const permissions = ['asset:name/fixtures/*:read'];
    const stop = new Error('stop after capturing paired create');
    const primaryCreate = jest.fn().mockResolvedValue({
      metadata: { id: 'instance_test' },
      status: { state: 'ready' },
    });
    const secondaryCreate = jest.fn().mockRejectedValue(stop);
    const command = new Command([], {} as never);
    Object.assign(command, {
      parse: async () => ({
        args: {},
        flags: {
          [flag]: true,
          'reuse-if-exists': true,
          'no-snapshot': true,
          permission: permissions,
        },
      }),
      withAuth: async (fn: () => Promise<void>) => fn(),
      consoleStreamUrl: () => 'https://console.example.test/stream/instance_test',
      info: jest.fn(),
    });
    Object.defineProperty(command, 'client', {
      value: {
        [primary]: { create: primaryCreate, createClient: jest.fn().mockResolvedValue({}) },
        [secondary]: { create: secondaryCreate },
      },
    });
    await expect(command.run()).rejects.toThrow(stop);
    expect(primaryCreate).toHaveBeenCalledWith(expect.objectContaining({ reuseIfExists: undefined }));
    expect(secondaryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        reuseIfExists: undefined,
        spec: expect.objectContaining({ role: { permissions: flag === 'xcode' ? permissions : [] } }),
      }),
    );
  },
);
