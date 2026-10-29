import { BaseCommand } from './base-command';
import IosCreate from './commands/ios/create';
import AndroidCreate from './commands/android/create';
import XcodeCreate from './commands/xcode/create';
import GradleCreate from './commands/gradle/create';
import Run from './commands/run';
import XcodeSync from './commands/xcode/sync';
import XcodeTest from './commands/xcode/test';
import GradleSync from './commands/gradle/sync';

const platforms = [
  [IosCreate, 'iosInstances'],
  [AndroidCreate, 'androidInstances'],
  [XcodeCreate, 'xcodeInstances'],
  [GradleCreate, 'gradleInstances'],
] as const;

describe.each(platforms)('%s create permissions', (Command, resource) => {
  test.each([{ permissions: [] }, { permissions: ['asset:name/fixtures/*:read'] }])(
    'sends explicit grants %j',
    async ({ permissions }) => {
      const stop = new Error('stop after capturing create');
      const create = jest.fn().mockRejectedValue(stop);
      const command = new Command([], {} as never);
      Object.assign(command, {
        parse: async () => ({
          args: {},
          flags: {
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
        expect.objectContaining({ spec: expect.objectContaining({ role: { permissions } }) }),
      );
    },
  );
});

test.each([Run, XcodeSync, XcodeTest, GradleSync])('%s exposes creation-time permissions', (Command) => {
  expect(Command.flags.permission).toBe(BaseCommand.permissionFlags.permission);
});
