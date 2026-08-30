import type { AndroidInstance } from '@limrun/api/resources/android-instances';
import type { IosInstance } from '@limrun/api/resources/ios-instances';
import type { Config } from '@oclif/core';

const mockLoadLastAndroidInstance = jest.fn();
const mockLoadLastIosInstance = jest.fn();
const mockRegisterCreatedInstance = jest.fn();

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  loadLastAndroidInstance: mockLoadLastAndroidInstance,
  loadLastIosInstance: mockLoadLastIosInstance,
  registerCreatedInstance: mockRegisterCreatedInstance,
}));

jest.mock('./lib/set-instance', () => ({
  ...jest.requireActual('./lib/set-instance'),
  envInstanceTarget: jest.fn(() => undefined),
}));

import { BaseCommand } from './base-command';
import type { LastAndroidInstance, LastIosInstance } from './lib/config';

class DeviceSyncTestCommand extends BaseCommand {
  public messages: string[] = [];

  async run(): Promise<void> {}

  public resolveAndroid(): Promise<LastAndroidInstance> {
    return this.resolveAndroidInstanceOrCreate(undefined);
  }

  public resolveIos(): Promise<LastIosInstance> {
    return this.resolveIosInstanceOrCreate(undefined);
  }

  protected info(message = ''): void {
    this.messages.push(message);
  }
}

describe('device instance auto-creation', () => {
  beforeEach(() => {
    mockLoadLastAndroidInstance.mockReset().mockReturnValue(null);
    mockLoadLastIosInstance.mockReset().mockReturnValue(null);
    mockRegisterCreatedInstance.mockReset().mockImplementation((instance) => ({
      id: instance.metadata.id,
      type: instance.metadata.id.startsWith('ios_') ? 'ios' : 'android',
    }));
  });

  test('creates an iOS instance when ios sync has no target', async () => {
    const instance = { metadata: { id: 'ios_test_00000000000000000000' } } as IosInstance;
    const create = jest.fn().mockResolvedValue(instance);
    const command = makeCommand('ios:sync', true, {
      iosInstances: { create },
      androidInstances: { create: jest.fn() },
    });

    await expect(command.resolveIos()).resolves.toEqual({
      id: instance.metadata.id,
      type: 'ios',
    });
    expect(create).toHaveBeenCalledWith({ wait: true, spec: {} });
    expect(command.messages).toEqual([
      `No recent iOS instance found. Created instance ${instance.metadata.id}.`,
    ]);
  });

  test('creates an Android instance when android sync has no target', async () => {
    const instance = {
      metadata: { id: 'android_test_00000000000000000000' },
    } as AndroidInstance;
    const create = jest.fn().mockResolvedValue(instance);
    const command = makeCommand('android:sync', true, {
      iosInstances: { create: jest.fn() },
      androidInstances: { create },
    });

    await expect(command.resolveAndroid()).resolves.toEqual({
      id: instance.metadata.id,
      type: 'android',
    });
    expect(create).toHaveBeenCalledWith({ wait: true, spec: {} });
    expect(command.messages).toEqual([
      `No recent Android instance found. Created instance ${instance.metadata.id}.`,
    ]);
  });

  test.each([
    ['ios:sync', 'iOS', (command: DeviceSyncTestCommand) => command.resolveIos()],
    ['android:sync', 'Android', (command: DeviceSyncTestCommand) => command.resolveAndroid()],
  ])('%s honors --no-create when no target exists', async (id, platform, resolve) => {
    const createIos = jest.fn();
    const createAndroid = jest.fn();
    const command = makeCommand(id, false, {
      iosInstances: { create: createIos },
      androidInstances: { create: createAndroid },
    });

    await expect(resolve(command)).rejects.toThrow(`No ${platform} instance found.`);
    expect(createIos).not.toHaveBeenCalled();
    expect(createAndroid).not.toHaveBeenCalled();
  });
});

function makeCommand(
  id: string,
  create: boolean,
  client: {
    iosInstances: { create: jest.Mock };
    androidInstances: { create: jest.Mock };
  },
): DeviceSyncTestCommand {
  const command = Object.create(DeviceSyncTestCommand.prototype) as DeviceSyncTestCommand;
  Object.defineProperties(command, {
    id: { value: id },
    _parsedFlags: { value: { create }, writable: true },
    _client: { value: client, writable: true },
    _instancesCreatedThisRun: { value: new Set<string>(), writable: true },
    messages: { value: [], writable: true },
    config: { value: {} as Config },
  });
  return command;
}
