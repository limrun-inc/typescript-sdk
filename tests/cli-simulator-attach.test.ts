import { EventEmitter } from 'events';

const mockRegisterCreatedInstance = jest.fn();

jest.mock('../packages/cli/src/lib/config', () => ({
  clearLastInstanceId: jest.fn(),
  loadAndroidInstanceCache: jest.fn(() => null),
  loadIosInstanceCache: jest.fn(() => null),
  loadLastAndroidInstance: jest.fn(() => null),
  loadLastIosInstance: jest.fn(() => null),
  loadLastXcodeInstance: jest.fn(() => null),
  loadXcodeInstanceCache: jest.fn(() => null),
  readConfig: jest.fn(() => ({
    apiKey: 'key',
    apiEndpoint: 'https://api.example.test',
    consoleEndpoint: 'https://console.example.test',
  })),
  registerCreatedInstance: mockRegisterCreatedInstance,
}));

const IosCreate = require('../packages/cli/src/commands/ios/create').default;
const XcodeBuild = require('../packages/cli/src/commands/xcode/build').default;
const XcodeCreate = require('../packages/cli/src/commands/xcode/create').default;

type CommandLike = {
  run(): Promise<void>;
  parse: jest.Mock;
  setParsedFlags: jest.Mock;
  withAuth: jest.Mock;
  info: jest.Mock;
  output: jest.Mock;
  outputJson: jest.Mock;
  error: jest.Mock;
  consoleStreamUrl: jest.Mock;
  signedStreamUrl: jest.Mock;
  resolveXcodeTarget?: jest.Mock;
  resolveXcodeClient?: jest.Mock;
  resolveSimulatorBackedXcodeTargetOrCreate?: jest.Mock;
};

function makeCommand(
  prototype: object,
  parsed: { args?: Record<string, unknown>; flags: Record<string, unknown> },
  client: unknown,
): CommandLike {
  const command = Object.create(prototype) as CommandLike;
  command.parse = jest.fn(async () => ({ args: parsed.args ?? {}, flags: parsed.flags }));
  command.setParsedFlags = jest.fn();
  command.withAuth = jest.fn(async (fn: () => Promise<unknown>) => fn());
  command.info = jest.fn();
  command.output = jest.fn();
  command.outputJson = jest.fn();
  command.error = jest.fn((message: string) => {
    throw new Error(message);
  });
  command.consoleStreamUrl = jest.fn((id: string) => `https://console.example.test/stream/${id}`);
  command.signedStreamUrl = jest.fn((status?: { signedStreamUrl?: string }) => status?.signedStreamUrl);
  Object.defineProperty(command, 'client', { get: () => client });
  return command;
}

function iosInstance(id: string) {
  return {
    metadata: { id },
    spec: { region: 'us-west' },
    status: {
      state: 'ready',
      apiUrl: `https://${id}.example.test/api`,
      token: `${id}-token`,
      signedStreamUrl: `https://stream.example.test/${id}`,
    },
  };
}

function xcodeInstance(id: string) {
  return {
    metadata: { id },
    spec: { region: 'us-west' },
    status: {
      state: 'ready',
      apiUrl: `https://${id}.example.test/api`,
      token: `${id}-token`,
    },
  };
}

function buildProcess(exitCode = 0) {
  return Object.assign(Promise.resolve({ exitCode }), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

describe('CLI simulator attach flows', () => {
  beforeEach(() => {
    mockRegisterCreatedInstance.mockClear();
  });

  test('ios create --attach creates a simulator and attaches it to the Xcode target', async () => {
    const simulator = iosInstance('ios_123');
    const attachSimulator = jest.fn(async () => ({
      attached: true,
      alreadyAttached: false,
      installedLastBuild: true,
      latestBuild: {
        buildId: 'build-1',
        sdk: 'iphonesimulator',
        installState: 'installedOnAttachedSimulator',
      },
    }));
    const client = {
      assets: { getOrUpload: jest.fn() },
      iosInstances: { create: jest.fn(async () => simulator) },
    };
    const command = makeCommand(
      IosCreate.prototype,
      {
        args: { xcodeId: 'xcode_123' },
        flags: {
          attach: true,
          xcode: false,
          'reuse-if-exists': true,
        },
      },
      client,
    );
    command.resolveXcodeTarget = jest.fn(async () => ({ id: 'xcode_123', type: 'xcode' }));
    command.resolveXcodeClient = jest.fn(async () => ({ attachSimulator }));

    await command.run();

    expect(command.resolveXcodeTarget).toHaveBeenCalledWith('xcode_123');
    expect(client.iosInstances.create).toHaveBeenCalledWith(
      expect.objectContaining({
        wait: true,
        reuseIfExists: true,
        spec: {},
      }),
    );
    expect(attachSimulator).toHaveBeenCalledWith(simulator);
    expect(command.outputJson).not.toHaveBeenCalled();
  });

  test('ios create --attach includes attach result in JSON output', async () => {
    const simulator = iosInstance('ios_123');
    const attachResult = {
      attached: true,
      alreadyAttached: true,
      installedLastBuild: false,
    };
    const attachSimulator = jest.fn(async () => attachResult);
    const client = {
      assets: { getOrUpload: jest.fn() },
      iosInstances: { create: jest.fn(async () => simulator) },
    };
    const command = makeCommand(
      IosCreate.prototype,
      {
        args: { xcodeId: 'xcode_123' },
        flags: {
          attach: true,
          json: true,
          xcode: false,
        },
      },
      client,
    );
    command.resolveXcodeTarget = jest.fn(async () => ({ id: 'xcode_123', type: 'xcode' }));
    command.resolveXcodeClient = jest.fn(async () => ({ attachSimulator }));

    await command.run();

    expect(command.outputJson).toHaveBeenCalledWith({
      ...simulator,
      attach: {
        xcodeInstanceId: 'xcode_123',
        simulatorInstanceId: 'ios_123',
        ...attachResult,
      },
    });
  });

  test('ios create --attach --rm deletes the created simulator when attach fails', async () => {
    const simulator = iosInstance('ios_123');
    const attachError = new Error('attach failed');
    const attachSimulator = jest.fn(async () => {
      throw attachError;
    });
    const client = {
      assets: { getOrUpload: jest.fn() },
      iosInstances: {
        create: jest.fn(async () => simulator),
        delete: jest.fn(async () => undefined),
      },
    };
    const command = makeCommand(
      IosCreate.prototype,
      {
        args: { xcodeId: 'xcode_123' },
        flags: {
          attach: true,
          rm: true,
          xcode: false,
        },
      },
      client,
    );
    command.resolveXcodeTarget = jest.fn(async () => ({ id: 'xcode_123', type: 'xcode' }));
    command.resolveXcodeClient = jest.fn(async () => ({ attachSimulator }));

    await expect(command.run()).rejects.toThrow('attach failed');

    expect(client.iosInstances.delete).toHaveBeenCalledWith('ios_123');
  });

  test('xcode create --attach creates standalone Xcode and attaches the simulator', async () => {
    const simulator = iosInstance('ios_123');
    const xcode = xcodeInstance('xcode_123');
    const attachSimulator = jest.fn(async () => ({
      attached: true,
      alreadyAttached: false,
      installedLastBuild: false,
    }));
    const client = {
      iosInstances: { get: jest.fn(async () => simulator) },
      xcodeInstances: {
        create: jest.fn(async () => xcode),
        createClient: jest.fn(async () => ({ attachSimulator })),
      },
    };
    const command = makeCommand(
      XcodeCreate.prototype,
      {
        flags: {
          attach: true,
          ios: false,
          'simulator-id': 'ios_123',
          'reuse-if-exists': true,
        },
      },
      client,
    );

    await command.run();

    expect(client.iosInstances.get).toHaveBeenCalledWith('ios_123');
    expect(client.xcodeInstances.create).toHaveBeenCalledWith(
      expect.objectContaining({
        wait: true,
        reuseIfExists: true,
        spec: {},
      }),
    );
    expect(client.xcodeInstances.createClient).toHaveBeenCalledWith({ instance: xcode });
    expect(attachSimulator).toHaveBeenCalledWith(simulator);
  });

  test('xcode create --attach --rm deletes the created Xcode when attach fails', async () => {
    const simulator = iosInstance('ios_123');
    const xcode = xcodeInstance('xcode_123');
    const attachSimulator = jest.fn(async () => {
      throw new Error('attach failed');
    });
    const client = {
      iosInstances: { get: jest.fn(async () => simulator) },
      xcodeInstances: {
        create: jest.fn(async () => xcode),
        createClient: jest.fn(async () => ({ attachSimulator })),
        delete: jest.fn(async () => undefined),
      },
    };
    const command = makeCommand(
      XcodeCreate.prototype,
      {
        flags: {
          attach: true,
          rm: true,
          ios: false,
          'simulator-id': 'ios_123',
        },
      },
      client,
    );

    await expect(command.run()).rejects.toThrow('attach failed');

    expect(client.xcodeInstances.delete).toHaveBeenCalledWith('xcode_123');
  });

  test('xcode build --ios uses the simulator-backed Xcode target without creating another pair', async () => {
    const simulator = iosInstance('ios_123');
    const sync = jest.fn(async () => ({}));
    const xcodebuild = jest.fn(() => buildProcess());
    const getSimulator = jest.fn(async () => ({
      attached: true,
      simulator: {
        apiUrl: simulator.status.apiUrl,
        iosInstanceId: simulator.metadata.id,
      },
    }));
    const client = {
      iosInstances: {
        create: jest.fn(),
        get: jest.fn(async () => simulator),
      },
    };
    const command = makeCommand(
      XcodeBuild.prototype,
      {
        args: { path: '/tmp/project' },
        flags: {
          ios: true,
        },
      },
      client,
    );
    command.resolveSimulatorBackedXcodeTargetOrCreate = jest.fn(async () => ({
      id: 'xcode_123',
      type: 'xcode',
    }));
    command.resolveXcodeClient = jest.fn(async () => ({
      sync,
      xcodebuild,
      getSimulator,
    }));

    await command.run();

    expect(command.resolveSimulatorBackedXcodeTargetOrCreate).toHaveBeenCalledWith(undefined);
    expect(client.iosInstances.create).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledWith('/tmp/project', expect.objectContaining({ watch: false }));
    expect(xcodebuild).toHaveBeenCalledWith({ sdk: 'iphonesimulator' }, undefined);
    expect(getSimulator).toHaveBeenCalled();
  });
});
