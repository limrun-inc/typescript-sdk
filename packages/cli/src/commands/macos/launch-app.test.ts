import MacosLaunchApp from './launch-app';
import MacosTerminateApp from './terminate-app';

function setup(Cmd: { prototype: object }, args: Record<string, unknown>, flags: Record<string, unknown>) {
  const client = {
    launchApp: jest.fn().mockResolvedValue({ bundleId: 'com.example.app', pid: 42, launched: true }),
    terminateApp: jest.fn().mockResolvedValue(undefined),
  };
  const resolveMacosClient = jest.fn(async () => ({ id: 'macos_test', client }));
  const outputResult = jest.fn();
  const command = Object.assign(Object.create(Cmd.prototype), {
    parse: async () => ({ args, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient,
    outputResult,
  }) as { run(): Promise<void> };
  return { command, client, resolveMacosClient, outputResult };
}

test('launches with arguments, environment and mode', async () => {
  const { command, client, outputResult } = setup(
    MacosLaunchApp,
    { app: 'com.example.app' },
    {
      mode: 'RelaunchIfRunning',
      arg: ['-v', '--port=1'],
      env: ['API_URL=https://example.com?a=b', 'EMPTY='],
    },
  );
  await command.run();
  expect(client.launchApp).toHaveBeenCalledWith('com.example.app', {
    mode: 'RelaunchIfRunning',
    arguments: ['-v', '--port=1'],
    env: { API_URL: 'https://example.com?a=b', EMPTY: '' },
  });
  expect(outputResult).toHaveBeenCalledWith(
    { bundleId: 'com.example.app', pid: 42, launched: true },
    'Launched com.example.app (pid 42)',
  );
});

test('sends neither arguments nor environment when none are given', async () => {
  const { command, client } = setup(MacosLaunchApp, { app: 'Safari' }, { mode: 'ForegroundIfRunning' });
  await command.run();
  expect(client.launchApp).toHaveBeenCalledWith('Safari', { mode: 'ForegroundIfRunning' });
});

test('says when the app was already running', async () => {
  const { command, client, outputResult } = setup(
    MacosLaunchApp,
    { app: 'com.example.app' },
    { mode: 'ForegroundIfRunning' },
  );
  client.launchApp.mockResolvedValue({ bundleId: 'com.example.app', pid: 7, launched: false });
  await command.run();
  expect(outputResult).toHaveBeenCalledWith(
    expect.anything(),
    'com.example.app was already running (pid 7); brought it to the front',
  );
});

test('rejects --env without = before reaching the instance', async () => {
  const { command, resolveMacosClient } = setup(
    MacosLaunchApp,
    { app: 'com.example.app' },
    { mode: 'ForegroundIfRunning', env: ['API_URL'] },
  );
  await expect(command.run()).rejects.toThrow('--env takes KEY=VALUE, got API_URL');
  expect(resolveMacosClient).not.toHaveBeenCalled();
});

test('terminate-app stops the app by bundle ID', async () => {
  const { command, client, outputResult } = setup(MacosTerminateApp, { bundleId: 'com.example.app' }, {});
  await command.run();
  expect(client.terminateApp).toHaveBeenCalledWith('com.example.app');
  expect(outputResult).toHaveBeenCalledWith(
    { ok: true, bundleId: 'com.example.app' },
    'Terminated com.example.app',
  );
});
