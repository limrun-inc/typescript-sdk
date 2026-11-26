import { startDetached } from '../lib/detached';
import AndroidConnect from './android/connect';
import IosForward from './ios/forward';
import IosReverse from './ios/reverse';
import MacosForward from './macos/forward';
import MacosSsh from './macos/ssh';

jest.mock('../lib/detached', () => ({ ...jest.requireActual('../lib/detached'), startDetached: jest.fn() }));

// Long-running commands return the terminal unless --no-detach keeps them in the foreground.
test.each([
  ['ios forward', IosForward],
  ['macos forward', MacosForward],
  ['macos ssh', MacosSsh],
  ['ios reverse', IosReverse],
  ['android connect', AndroidConnect],
])('%s detaches by default and takes --no-detach', (_name, command) => {
  const flag = (command.flags as Record<string, { default?: unknown; allowNo?: boolean }>)['detach'];
  expect(flag?.default).toBe(true);
  expect(flag?.allowNo).toBe(true);
});

function run(
  command: { prototype: object },
  args: Record<string, unknown>,
  flags: Record<string, unknown>,
): { done: Promise<void>; outputJson: jest.Mock; withAuth: jest.Mock } {
  const outputJson = jest.fn();
  const withAuth = jest.fn();
  const instance = Object.assign(Object.create(command.prototype), {
    parse: async () => ({ args, flags }),
    setParsedFlags: jest.fn(),
    withAuth,
    resolveIosInstance: () => ({ id: 'ios_test' }),
    resolveAndroidInstance: () => ({ id: 'android_test' }),
    resolveMacosTarget: () => ({ id: 'macos_test' }),
    isJsonEnabled: () => true,
    outputJson,
    info: jest.fn(),
    output: jest.fn(),
  });
  return { done: instance.run(), outputJson, withAuth };
}

beforeEach(() => {
  jest.mocked(startDetached).mockResolvedValue({ pid: 7, logPath: '/tmp/x.log', ready: { ok: true } });
});

test.each([
  [
    IosForward,
    { mapping: '8080:3000' },
    { detach: true, json: true, 'api-key': 'k' },
    {
      name: 'ios-forward-ios_test-8080-3000',
      args: ['ios', 'forward', '8080:3000', '--id', 'ios_test', '--api-key', 'k'],
    },
  ],
  [
    MacosForward,
    { mapping: '3000' },
    { detach: true, json: true },
    { name: 'macos-forward-macos_test-3000', args: ['macos', 'forward', '3000', '--id', 'macos_test'] },
  ],
  [
    IosReverse,
    { mapping: '57090:8081' },
    { detach: true, json: true, 'local-host': '127.0.0.1' },
    {
      name: 'ios-reverse-ios_test-57090-8081',
      args: ['ios', 'reverse', '57090:8081', '--id', 'ios_test', '--local-host', '127.0.0.1'],
    },
  ],
  [
    AndroidConnect,
    {},
    { detach: true, json: true, 'adb-path': 'adb' },
    {
      name: 'android-connect-android_test',
      args: ['android', 'connect', '--id', 'android_test', '--adb-path', 'adb'],
    },
  ],
])('%p runs itself in the background and reports its PID', async (command, args, flags, expected) => {
  const { done, outputJson, withAuth } = run(command, args, flags);
  await done;
  expect(startDetached).toHaveBeenCalledWith(expected);
  // The background process connects; this one returns without opening anything.
  expect(withAuth).not.toHaveBeenCalled();
  expect(outputJson).toHaveBeenCalledWith({ ok: true, pid: 7, logPath: '/tmp/x.log' });
});
