import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import {
  ensureDaemonSession,
  getAndroidInstanceClient,
  getIosInstanceClient,
  sendSessionCommand,
} from './lib/instance-client-factory';
import * as daemon from './lib/daemon';
import { streamBuildCommand } from './lib/build-command-helpers';

jest.mock('@limrun/api', () => ({ ...jest.requireActual('@limrun/api'), createInstanceClient: jest.fn() }));

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }));
jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  registerCreatedInstance: jest.fn(),
  clearLastInstanceId: jest.fn(),
  writeConfig: jest.fn(),
  clearConfig: jest.fn(),
}));
jest.mock('./lib/instance-client-factory', () => ({
  ...jest.requireActual('./lib/instance-client-factory'),
  ensureDaemonSession: jest.fn(),
  getAndroidInstanceClient: jest.fn(),
  getIosInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));
jest.mock('./lib/daemon', () => ({
  ...jest.requireActual('./lib/daemon'),
  stopDaemon: jest.fn(),
  clearSession: jest.fn(),
  isDaemonRunning: jest.fn(),
  listActiveSessions: jest.fn(),
  getDaemonPid: jest.fn().mockReturnValue(123),
  spawnSessionDaemon: jest.fn(),
}));
jest.mock('./lib/backend', () => ({
  ...jest.requireActual('./lib/backend'),
  tunnelOrganization: jest.fn().mockResolvedValue('org_test'),
  findTunnel: jest.fn().mockResolvedValue({ id: 'tunnel_test' }),
  deleteTunnel: jest.fn(),
}));

const instance = {
  metadata: { id: 'android_useb_01m52x3ensfq9bebh7aegpd77q' },
  spec: { region: 'us-east2' },
  status: { state: 'ready', apiUrl: 'https://instance.example.test', token: 'test-token' },
};
const target = { id: instance.metadata.id, type: 'android', apiUrl: instance.status.apiUrl, token: 'test' };
let stdout: string;
let stderr: string;
let client: Record<string, jest.Mock>;
let cleanup: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  stdout = '';
  stderr = '';
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += String(chunk);
    return true;
  });
  jest.spyOn(console, 'log').mockImplementation((...args) => {
    stdout += require('util').format(...args) + '\n';
  });
  jest.spyOn(console, 'error').mockImplementation((...args) => {
    stderr += require('util').format(...args) + '\n';
  });
  cleanup = jest.fn();
  client = Object.fromEntries(
    [
      'setText',
      'scrollScreen',
      'scrollElement',
      'tap',
      'typeText',
      'pressKey',
      'scroll',
      'openURL',
      'openUrl',
      'terminateApp',
      'toggleKeyboard',
      'performActions',
      'sendAsset',
      'launchApp',
      'setWifiBandwidth',
      'startRecording',
      'stopRecording',
    ].map((name) => [name, jest.fn().mockResolvedValue(undefined)]),
  );
  jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client, disconnect: cleanup } as never);
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect: cleanup } as never);
  jest.mocked(daemon.listActiveSessions).mockReturnValue([]);
  jest.mocked(daemon.isDaemonRunning).mockReturnValue(false);
  jest.mocked(spawn).mockReturnValue({ pid: 11656, unref: jest.fn() } as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function command(name: string, args: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) {
  const Class = require(`./commands/${name}`).default;
  const result = new Class([], {});
  Object.assign(result, {
    _parsedFlags: { json: true, ...flags } as Record<string, unknown>,
    parse: async () => ({ args, flags: { json: true, ...flags } }),
    setParsedFlags(value: Record<string, unknown>) {
      this._parsedFlags = value;
    },
    withAuth: (fn: () => unknown) => fn(),
    resolveAndroidInstance: () => target,
    resolveIosInstance: () => ({ ...target, type: 'ios' }),
    resolveDeviceInstance: () => target,
    resolveGradleTarget: () => target,
    resolveXcodeTarget: async () => target,
    resolveAndroidInstanceOrCreate: async () => target,
    resolveIosInstanceOrCreate: async () => target,
    resolveXcodeTargetOrCreate: async () => target,
    resolveGradleTargetOrCreate: async () => target,
    resolveXcodeClientForWork: async () => client,
    resolveGradleClient: async () => client,
    consoleStreamUrl: () => 'https://console.example.test',
    signedStreamUrl: () => undefined,
  });
  const resource = {
    create: jest.fn().mockResolvedValue(instance),
    delete: jest.fn(),
    get: jest.fn().mockResolvedValue(instance),
  };
  Object.defineProperty(result, 'client', {
    value: {
      androidInstances: resource,
      iosInstances: resource,
      xcodeInstances: resource,
      gradleInstances: resource,
      assets: resource,
    },
  });
  return result;
}

const actions: Array<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
  ['tap', { x: 0, y: 200 }, {}, { x: 0, y: 200 }],
  ['type', { text: 'hello\nworld' }, { enter: false, 'require-focus': true }, { textLength: 11 }],
  ['press-key', { key: 'home' }, {}, { key: 'home', modifiers: [] }],
  ['scroll', { direction: 'down' }, { amount: 300 }, { direction: 'down', amount: 300 }],
  ['open-url', { url: 'https://example.test' }, {}, { url: 'https://example.test' }],
  ['terminate-app', { bundleId: 'com.example.app', packageName: 'com.example.app' }, {}, {}],
];
describe.each([false, true])('device actions with daemon=%s', (session) => {
  beforeEach(() => jest.mocked(ensureDaemonSession).mockResolvedValue(session));
  test.each(
    ['android', 'ios'].flatMap((platform) =>
      actions.map(([name, args, flags, expected]) => [`${platform}/${name}`, args, flags, expected] as const),
    ),
  )('%s emits the resolved target and action parameters', async (name, args, flags, expected) => {
    await command(name, args, flags).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      ...expected,
      ...(name === 'ios/type' ? { enter: false, requireFocus: true } : {}),
      ...(name === 'ios/terminate-app' ? { bundleId: args.bundleId } : {}),
      ...(name === 'android/terminate-app' ? { packageName: args.packageName } : {}),
    });
    if (session && name !== 'android/terminate-app') expect(sendSessionCommand).toHaveBeenCalled();
    else expect(cleanup).toHaveBeenCalledTimes(1);
  });
  test('iOS gesture results preserve parsed values and zero momentum', async () => {
    await command(
      'ios/scroll',
      { direction: 'up' },
      { amount: 500, momentum: '0', coordinate: '0,240' },
    ).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      direction: 'up',
      amount: 500,
      momentum: 0,
      coordinate: [0, 240],
    });
    stdout = '';
    await command('ios/swipe', {}, { from: '10,20', to: '30,40', duration: 800 }).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      from: [10, 20],
      to: [30, 40],
      durationMs: 800,
    });
  });
  test('keyboard toggle identifies the instance without inventing visibility', async () => {
    await command('ios/toggle-keyboard').run();
    expect(JSON.parse(stdout)).toEqual({ ok: true, instanceId: target.id });
  });
  test.each(['android', 'ios'])('%s key result includes modifiers', async (platform) => {
    await command(`${platform}/press-key`, { key: 'a' }, { modifier: ['shift', 'control'] }).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      key: 'a',
      modifiers: ['shift', 'control'],
    });
  });
  test('Android actions report the actual selector or coordinate target', async () => {
    await command(
      'android/scroll',
      { direction: 'down' },
      { amount: 500, 'resource-id': 'com.example:id/list', enabled: false },
    ).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      direction: 'down',
      amount: 500,
      target: { selector: { resourceId: 'com.example:id/list', enabled: false } },
    });
    stdout = '';
    await command('android/type', { text: 'secret' }, { x: 0, y: 20 }).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      textLength: 6,
      target: { x: 0, y: 20 },
    });
  });
  test.each([true, false])('Android install result identifies its source, local=%s', async (local) => {
    const source = local ? '/tmp/app.apk' : 'https://example.test/app.apk';
    const c = command('android/install-app', { path_or_url: source });
    jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
    c.client.assets.getOrUpload = jest
      .fn()
      .mockResolvedValue({ id: 'asset_test', signedDownloadUrl: 'https://download.test/signed' });
    await c.run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      source,
      ...(local ? { assetId: 'asset_test' } : {}),
    });
  });
  test.each(['android', 'ios'])('%s record start and stop have stable responses', async (platform) => {
    await command(`${platform}/record`, { action: 'start' }, { quality: 5 }).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      recording: true,
      quality: 5,
      persist: false,
    });
    stdout = '';
    await command(
      `${platform}/record`,
      { action: 'stop' },
      { output: '/tmp/contract-recording.mp4', 'presigned-url': 'https://upload.example.test' },
    ).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      recording: false,
      localPath: '/tmp/contract-recording.mp4',
      uploaded: true,
    });
  });
  test('bandwidth preserves zero and omits the unchanged direction', async () => {
    await command('android/set-wifi-bandwidth', {}, { 'down-kbps': 0 }).run();
    expect(JSON.parse(stdout)).toEqual({ ok: true, instanceId: target.id, downKbps: 0 });
  });
});

test.each(['android', 'ios', 'xcode', 'gradle'])('%s delete emits the resource ID', async (platform) => {
  await command(`${platform}/delete`, { id: target.id }).run();
  expect(JSON.parse(stdout)).toEqual({ ok: true, id: target.id });
});

test.each([true, false])('Android create emits the API resource with connect=%s', async (connect) => {
  await command('android/create', {}, { connect, daemon: true, open: true, 'hard-timeout': '10m' }).run();
  expect(JSON.parse(stdout)).toEqual(instance);
  expect(stderr).toBe('');
  expect(spawn).toHaveBeenCalledTimes(connect ? 1 : 0);
});

test('Android create retains human tunnel instructions without --json', async () => {
  await command('android/create', {}, { json: false, connect: true, daemon: true }).run();
  expect(stdout).toContain('ADB tunnel starting in background (PID 11656).');
  expect(stdout).toContain(`lim android delete ${instance.metadata.id}`);
});

test('an accidental human log cannot corrupt JSON stdout', async () => {
  const c = command('android/create');
  c.log('diagnostic');
  c.output('another diagnostic');
  c.outputJson(instance);
  expect(JSON.parse(stdout)).toEqual(instance);
  expect(stderr).toContain('diagnostic');
});

test.each(['android', 'ios', 'xcode', 'gradle'])(
  '%s sync emits one final result or NDJSON watch events',
  async (platform) => {
    const data = {
      bytesSent: 123,
      durationMs: 12,
      ...(platform === 'ios' ? { installedBundleId: 'com.example.app' } : {}),
    };
    client.syncApp = client.sync = jest.fn().mockImplementation(async (_path, options) => {
      options.onSyncComplete(data);
      return data;
    });
    await command(`${platform}/sync`, { path: '/tmp/project' }).run();
    expect(JSON.parse(stdout)).toEqual(data);
    stdout = '';
    // The mocked watcher completes immediately after its last update.
    client.syncApp = client.sync = jest.fn().mockImplementation(async (_path, options) => {
      options.onSyncComplete(data);
      options.onSyncComplete({ ...data, bytesSent: 3 });
      return data;
    });
    await command(`${platform}/sync`, { path: '/tmp/project' }, { watch: true }).run();
    expect(
      stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([data, { ...data, bytesSent: 3 }]);
  },
);

test('session stop --all emits a single result, including an empty list', async () => {
  await command('session/stop', {}, { all: true }).run();
  expect(JSON.parse(stdout)).toEqual({ stopped: [] });
  stdout = '';
  jest.mocked(daemon.listActiveSessions).mockReturnValue([
    { instanceId: 'ios_one', pid: 11 },
    { instanceId: 'android_two', pid: 12 },
  ]);
  await command('session/stop', {}, { all: true }).run();
  expect(JSON.parse(stdout)).toEqual({ stopped: ['ios_one', 'android_two'] });
  expect(daemon.stopDaemon).toHaveBeenCalledTimes(2);
});

test.each([true, false])('session start reports alreadyRunning=%s', async (running) => {
  jest.mocked(daemon.isDaemonRunning).mockReturnValue(running);
  await command('session/start').run();
  expect(JSON.parse(stdout)).toEqual({ instanceId: target.id, running: true, alreadyRunning: running });
});

test('session stop ambiguity fails without a success result', async () => {
  jest.mocked(daemon.listActiveSessions).mockReturnValue([
    { instanceId: 'ios_one', pid: 11 },
    { instanceId: 'android_two', pid: 12 },
  ]);
  await expect(command('session/stop').run()).rejects.toThrow('Specify --id or --all');
  expect(stdout).toBe('');
});

test('JSON log records escape embedded newlines', () => {
  const c = command('ios/syslog');
  c.outputEvent({ line: 'one\ntwo' });
  c.outputEvent({ line: 'three' });
  expect(
    stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([{ line: 'one\ntwo' }, { line: 'three' }]);
});

test.each([0, 7])('remote commands preserve stdout, stderr and exit code %s', async (exitCode) => {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const proc = Object.assign(
    new Promise<any>((resolve) => {
      setImmediate(() => {
        out.emit('data', 'hello');
        err.emit('data', 'warning');
        resolve({ execId: 'exec_test', status: exitCode ? 'FAILED' : 'SUCCEEDED', exitCode });
      });
    }),
    { stdout: out, stderr: err },
  );
  const reportError = jest.fn((message: string) => {
    throw new Error(message);
  });
  const result = jest.fn();
  const run = streamBuildCommand(proc as never, reportError, 'Command failed', result);
  if (exitCode) await expect(run).rejects.toThrow('exit code 7');
  else await run;
  expect(result).toHaveBeenCalledWith({
    execId: 'exec_test',
    status: exitCode ? 'FAILED' : 'SUCCEEDED',
    exitCode,
    stdout: 'hello\n',
    stderr: 'warning\n',
  });
  expect(stdout).toBe('');
});

test.each(['xcode', 'gradle'])(
  '%s foreground build returns the API execution result on success and failure',
  async (platform) => {
    for (const exitCode of [0, 65]) {
      stdout = '';
      stderr = '';
      const expected = {
        execId: 'exec_test',
        status: exitCode ? 'FAILED' : 'SUCCEEDED',
        exitCode,
        ...(exitCode ?
          { timedOut: true, incomplete: { reason: 'stream-lost', message: 'Connection lost' } }
        : { signedDownloadUrl: 'https://download.example.test/app' }),
      };
      const out = new EventEmitter();
      const err = new EventEmitter();
      client.sync = jest.fn().mockResolvedValue({ bytesSent: 100 });
      client.gradlebuild = client.xcodebuild = jest.fn().mockImplementation(() =>
        Object.assign(
          new Promise((resolve) => {
            setImmediate(() => {
              out.emit('data', 'compiling');
              err.emit('data', 'warning');
              resolve(expected);
            });
          }),
          { stdout: out, stderr: err },
        ),
      );
      const c = command(`${platform}/build`);
      c.applyBuildCacheToTarget = async () => {};
      if (exitCode) await expect(c.run()).rejects.toMatchObject({ oclif: { exit: exitCode } });
      else await c.run();
      expect(JSON.parse(stdout)).toEqual({ instanceId: target.id, ...expected });
      expect(stderr).toContain('compiling');
      expect(stderr).toContain('warning');
    }
  },
);

test.each(['android', 'ios'])('%s detached launch returns an acknowledgement', async (platform) => {
  await command(
    `${platform}/launch-app`,
    { packageName: 'com.example.app', bundleId: 'com.example.app' },
    { detach: true },
  ).run();
  expect(JSON.parse(stdout)).toEqual({
    ok: true,
    instanceId: target.id,
    [platform === 'ios' ? 'bundleId' : 'packageName']: 'com.example.app',
    mode: 'ForegroundIfRunning',
  });
});

test('asset push preserves the API response', async () => {
  const fs = require('fs');
  jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  const c = command('asset/push', { file: '/tmp/app.apk' });
  const asset = { id: 'asset_test', name: 'app.apk', expiresAt: '2026-10-17T10:00:00Z', size: 234 };
  c.client.assets.getOrUpload = jest.fn().mockResolvedValue(asset);
  await c.run();
  expect(JSON.parse(stdout)).toEqual(asset);
});

test('key generation returns a named base64 key', async () => {
  await command('ios/keychain/generate-key').run();
  const value = JSON.parse(stdout);
  expect(Object.keys(value)).toEqual(['key']);
  expect(Buffer.from(value.key, 'base64')).toHaveLength(32);
});

test('tunnel and asset deletion return their IDs', async () => {
  await command('tunnel/delete', { name: 'staging' }).run();
  expect(JSON.parse(stdout)).toEqual({ ok: true, id: 'tunnel_test' });
  stdout = '';
  await command('asset/delete', { id: 'asset_test' }).run();
  expect(JSON.parse(stdout)).toEqual({ ok: true, id: 'asset_test' });
});

test('action failure emits no success acknowledgement', async () => {
  jest.mocked(ensureDaemonSession).mockResolvedValue(false);
  client.tap!.mockRejectedValue(new Error('device disconnected'));
  await expect(command('ios/tap', { x: 1, y: 2 }).run()).rejects.toThrow('device disconnected');
  expect(stdout).toBe('');
});

test.each([false, true])('Android foreground create emits JSON before waiting, rm=%s', async (rm) => {
  const api = require('@limrun/api');
  const signals: Array<() => void> = [];
  const tunnel = { address: { address: '127.0.0.1', port: 5555 }, close: jest.fn() };
  const direct = { startAdbTunnel: jest.fn().mockResolvedValue(tunnel), disconnect: jest.fn() };
  api.createInstanceClient.mockResolvedValue(direct);
  const originalOn = process.on.bind(process);
  jest.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
    if (event === 'SIGINT') {
      signals.push(handler);
      return process;
    }
    if (event === 'SIGTERM') return process;
    return originalOn(event as never, handler);
  }) as typeof process.on);
  const c = command('android/create', {}, { connect: true, daemon: rm, rm });
  const running = c.run();
  for (let i = 0; i < 20 && signals.length < (rm ? 2 : 1); i++) await new Promise(setImmediate);
  expect(JSON.parse(stdout)).toEqual(instance);
  expect(api.createInstanceClient).toHaveBeenCalledWith(expect.objectContaining({ logLevel: 'warn' }));
  signals[signals.length - 1]!();
  await running;
  expect(tunnel.close).toHaveBeenCalledTimes(1);
  expect(direct.disconnect).toHaveBeenCalledTimes(1);
});

test.each(['xcode', 'gradle'])('%s detached builds retain their existing contract', async (platform) => {
  client.sync = jest.fn().mockResolvedValue({ bytesSent: 100 });
  client.gradlebuild = client.xcodebuild = jest.fn().mockReturnValue({ detach: async () => 'exec_test' });
  const c = command(`${platform}/build`, {}, { detach: true });
  c.applyBuildCacheToTarget = async () => {};
  c.consoleBuildUrl = () => 'https://console.example.test/build';
  await c.run();
  expect(JSON.parse(stdout)).toEqual({
    instanceId: target.id,
    execId: 'exec_test',
    consoleUrl: 'https://console.example.test/build',
    logsCommand: `lim ${platform} logs exec_test --id ${target.id}`,
  });
});

test.each(['android/logcat', 'ios/syslog', 'ios/app-log'])(
  '%s frames actual log callbacks as NDJSON',
  async (name) => {
    const stream = Object.assign(new EventEmitter(), { stop: jest.fn() });
    let finishLogcat: (code: number) => void = () => {};
    Object.assign(stream, {
      wait: () =>
        new Promise<number>((resolve) => {
          finishLogcat = resolve;
        }),
    });
    stream.stop.mockImplementation(() => finishLogcat(0));
    client.logcat = client.streamSyslog = client.streamAppLog = jest.fn().mockReturnValue(stream);
    const signals: Array<() => void> = [];
    const originalOn = process.on.bind(process);
    jest.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT') {
        signals.push(listener);
        return process;
      }
      if (event === 'SIGTERM') return process;
      return originalOn(event as never, listener);
    }) as typeof process.on);
    const run = command(name, { bundleId: 'com.example.app' }, { follow: true }).run();
    for (let i = 0; i < 20 && !signals.length; i++) await new Promise(setImmediate);
    stream.emit('line', 'first\nsecond');
    stream.emit('line', 'third');
    signals[0]!();
    await run;
    expect(
      stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ line: 'first\nsecond' }, { line: 'third' }]);
  },
);

test('iOS display overrides appear in gesture results', async () => {
  client.tapDisplay = jest.fn();
  await command('ios/tap', { x: 0, y: 20 }, { display: 'inner' }).run();
  expect(JSON.parse(stdout)).toEqual({ ok: true, instanceId: target.id, x: 0, y: 20, display: 'inner' });
  expect(client.tapDisplay).toHaveBeenCalledWith('inner', 0, 20);
});

test('iOS launch reports the effective relaunch mode without echoing environment secrets', async () => {
  await command(
    'ios/launch-app',
    { bundleId: 'com.example.app' },
    { detach: true, env: ['API_TOKEN=secret'] },
  ).run();
  expect(JSON.parse(stdout)).toEqual({
    ok: true,
    instanceId: target.id,
    bundleId: 'com.example.app',
    mode: 'RelaunchIfRunning',
  });
});

test.each(['ios', 'android'])(
  '%s recording reports requested quality and parsed retention',
  async (platform) => {
    await command(
      `${platform}/record`,
      { action: 'start' },
      {
        quality: 8,
        persist: true,
        'persist-ttl': '24h',
        ...(platform === 'ios' ? { display: 'outer', 'touch-indicators': false } : {}),
      },
    ).run();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      instanceId: target.id,
      recording: true,
      quality: 8,
      persist: true,
      persistTtlSeconds: 86400,
      ...(platform === 'ios' ? { display: 'outer', touchIndicators: false } : {}),
    });
  },
);

test.each(['ios', 'android'])('%s camera results identify playback and clear actions', async (platform) => {
  client.setCameraVideo = jest.fn();
  client.clearCameraVideo = jest.fn();
  jest.spyOn(require('fs'), 'existsSync').mockReturnValue(true);
  await command(`${platform}/camera`, { action: 'play', path: '/tmp/clip.mp4' }, { loop: false }).run();
  expect(JSON.parse(stdout)).toEqual({
    ok: true,
    instanceId: target.id,
    action: 'play',
    localPath: '/tmp/clip.mp4',
    loop: false,
  });
  stdout = '';
  await command(`${platform}/camera`, { action: 'clear' }).run();
  expect(JSON.parse(stdout)).toEqual({ ok: true, instanceId: target.id, action: 'clear' });
});
