import { PassThrough } from 'stream';
import Run from './run';

jest.mock('../lib/config', () => ({
  ...jest.requireActual('../lib/config'),
  registerCreatedInstance: jest.fn(),
}));

function workflow(iosId?: string) {
  const order: string[] = [];
  const simulator = {
    metadata: { id: 'ios_existing' },
    status: { signedStreamUrl: 'https://console.test/device' },
  };
  const sandbox = { metadata: { id: 'sandbox_build' } };
  let finish!: (result: { exitCode: number }) => void;
  const build = Object.assign(
    new Promise<{ exitCode: number }>((resolve) => {
      finish = resolve;
    }),
    {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    },
  );
  const xcode = {
    attachSimulator: jest.fn(async () => {
      order.push('attach');
      return { installedLastBuild: true };
    }),
    sync: jest.fn(async () => {
      order.push('sync');
    }),
    xcodebuild: jest.fn(() => {
      order.push('build');
      return build;
    }),
  };
  const client = {
    xcodeInstances: {
      create: jest.fn(async () => sandbox),
      createClient: jest.fn(async () => xcode),
    },
    iosInstances: {
      get: jest.fn(async () => simulator),
      create: jest.fn(async () => {
        order.push('create-simulator');
        return simulator;
      }),
      delete: jest.fn(async () => {}),
    },
  };
  const command = Object.assign(Object.create(Run.prototype), {
    iosInstanceId: iosId,
    withAuth: async (run: () => Promise<string>) => run(),
    reporter: {
      withProgress: async (_label: string, fn: () => Promise<unknown>) => fn(),
      start: jest.fn(),
      stop: jest.fn(),
      appendLog: jest.fn(),
    },
    outputProjectRecovery: jest.fn(),
    error: (message: string) => {
      throw new Error(message);
    },
  });
  Object.defineProperty(command, 'client', { value: client });
  const run = () =>
    command.buildAndLaunchProject({
      projectRoot: '/app',
      displayName: 'app',
      labels: { project: 'app' },
      progressLabel: 'Building',
      failureLabel: 'Build failed',
      recoveryPath: '/app',
      recoveryFromDir: '/app',
    }) as Promise<string>;
  return { client, xcode, command, order, build, finish, run, simulator };
}

async function untilBuildStarts(flow: ReturnType<typeof workflow>) {
  for (let i = 0; i < 20 && !flow.xcode.xcodebuild.mock.calls.length; i++) await Promise.resolve();
  expect(flow.xcode.xcodebuild).toHaveBeenCalledTimes(1);
}

test('attaches the supplied simulator before syncing or streaming the build', async () => {
  const flow = workflow('ios_existing');
  const running = flow.run();
  await untilBuildStarts(flow);
  expect(flow.order).toEqual(['attach', 'sync', 'build']);
  expect(flow.xcode.attachSimulator).toHaveBeenCalledWith(flow.simulator);
  expect(flow.client.iosInstances.create).not.toHaveBeenCalled();
  flow.build.stdout.write('CompileSwift CheckoutView.swift');
  expect(flow.command.reporter.appendLog).toHaveBeenCalled();
  flow.finish({ exitCode: 0 });
  await expect(running).resolves.toBe('https://console.test/device');
  expect(flow.xcode.attachSimulator).toHaveBeenCalledTimes(2);
  expect(flow.client.iosInstances.delete).not.toHaveBeenCalled();
});

test('retains the supplied simulator when compilation fails', async () => {
  const flow = workflow('ios_existing');
  const running = flow.run();
  await untilBuildStarts(flow);
  flow.finish({ exitCode: 1 });
  await expect(running).rejects.toThrow('Build failed with exit code 1');
  expect(flow.client.iosInstances.delete).not.toHaveBeenCalled();
});

test('does not build or delete the supplied simulator when early attachment fails', async () => {
  const flow = workflow('ios_existing');
  flow.xcode.attachSimulator.mockRejectedValueOnce(new Error('Attach failed'));
  await expect(flow.run()).rejects.toThrow('Attach failed');
  expect(flow.xcode.sync).not.toHaveBeenCalled();
  expect(flow.xcode.xcodebuild).not.toHaveBeenCalled();
  expect(flow.client.iosInstances.delete).not.toHaveBeenCalled();
});

test.each([true, false])(
  'cleans up a failed install only for its own simulator, supplied=%s',
  async (supplied) => {
    const flow = workflow(supplied ? 'ios_existing' : undefined);
    const running = flow.run();
    await untilBuildStarts(flow);
    flow.xcode.attachSimulator.mockRejectedValueOnce(new Error('Install failed'));
    flow.finish({ exitCode: 0 });
    await expect(running).rejects.toThrow('Install failed');
    expect(flow.client.iosInstances.delete).toHaveBeenCalledTimes(supplied ? 0 : 1);
  },
);

test('creates an implicit simulator only after compilation succeeds', async () => {
  const flow = workflow();
  const running = flow.run();
  await untilBuildStarts(flow);
  expect(flow.order).toEqual(['sync', 'build']);
  expect(flow.client.iosInstances.create).not.toHaveBeenCalled();
  flow.finish({ exitCode: 0 });
  await expect(running).resolves.toBe('https://console.test/device');
  expect(flow.order).toEqual(['sync', 'build', 'create-simulator', 'attach']);
});

test('rejects an invalid supplied simulator before allocating a builder', async () => {
  const flow = workflow('ios_missing');
  flow.client.iosInstances.get.mockRejectedValueOnce(new Error('Simulator not found'));
  await expect(flow.run()).rejects.toThrow('Simulator not found');
  expect(flow.client.xcodeInstances.create).not.toHaveBeenCalled();
});

test('rebuilds when early attachment reports an install error from an older build', async () => {
  const flow = workflow('ios_existing');
  flow.xcode.attachSimulator.mockResolvedValueOnce({
    installedLastBuild: false,
    installError: 'Old app missing',
  } as never);
  const running = flow.run();
  await untilBuildStarts(flow);
  flow.finish({ exitCode: 0 });
  await expect(running).resolves.toBe('https://console.test/device');
  expect(flow.xcode.attachSimulator).toHaveBeenCalledTimes(2);
});
