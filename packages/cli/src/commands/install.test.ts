import fs from 'fs';
import os from 'os';
import path from 'path';
import { APIError } from '@limrun/api';
import IosInstall from './ios/install';
import AndroidInstall from './android/install';
import {
  ensureDaemonSession,
  getIosInstanceClient,
  getAndroidInstanceClient,
  sendSessionCommand,
} from '../lib/instance-client-factory';

jest.mock('../lib/instance-client-factory', () => ({
  ...jest.requireActual('../lib/instance-client-factory'),
  ensureDaemonSession: jest.fn(),
  getIosInstanceClient: jest.fn(),
  getAndroidInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

function setup(
  platform: 'ios' | 'android',
  source?: string,
  flags: Record<string, unknown> = { 'asset-name': 'releases/app:42.zip' },
  permissions: string[] = ['asset:name/unrelated:upload'],
) {
  const target = { id: `${platform}_euna_test`, type: platform };
  const events: string[] = [];
  const device = {
    installAppByName: jest.fn(async (assetName: string) => {
      events.push('install');
      return { bundleId: 'com.example.app', assetName };
    }),
    installApp: jest.fn().mockResolvedValue({ bundleId: 'com.example.app' }),
    sendAsset: jest.fn().mockResolvedValue(undefined),
  };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client: device, disconnect } as never);
  jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client: device, disconnect } as never);
  jest.mocked(sendSessionCommand).mockImplementation(async () => {
    events.push('install');
    return {};
  });
  const live = jest.fn(async () => ({
    data: { spec: { role: { permissions } }, status: { state: 'ready' } },
    response: new Response(null, { headers: { etag: '"42"' } }),
  }));
  const update = jest.fn(async () => {
    events.push('grant');
  });
  const get = jest.fn(() => ({ withResponse: live }));
  const assets = {
    getOrUpload: jest.fn(async ({ name }: { name: string }) => ({
      name,
      id: 'asset_test',
      signedDownloadUrl: 'https://storage.example/app',
    })),
    list: jest.fn(),
    get: jest.fn(),
  };
  const command = Object.assign(Object.create((platform === 'ios' ? IosInstall : AndroidInstall).prototype), {
    parse: async () => ({ args: { path_or_url: source }, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => target,
    resolveAndroidInstance: () => target,
    log: jest.fn(),
    info: jest.fn(),
    outputResult: jest.fn(),
    outputJson: jest.fn(),
    error: (message: string) => {
      throw new Error(message);
    },
  });
  Object.defineProperty(command, 'client', {
    value: { assets, iosInstances: { get, update }, androidInstances: { get, update } },
  });
  return { command, device, disconnect, update, get, live, assets, events, target };
}

beforeEach(() => jest.clearAllMocks());

describe.each(['ios', 'android'] as const)('%s named installs', (platform) => {
  test.each([true, false])('grants read before installing with daemon=%s', async (daemon) => {
    jest.mocked(ensureDaemonSession).mockResolvedValue(daemon);
    const { command, device, events, update, assets, target } = setup(platform, undefined, {
      'asset-name': 'releases/app:42.zip',
      'launch-mode': 'RelaunchIfRunning',
    });
    await command.run();
    expect(update).toHaveBeenCalledWith(target.id, {
      ifMatch: '"42"',
      spec: { role: { permissions: ['asset:name/unrelated:upload', 'asset:name/releases/app:42.zip:read'] } },
    });
    expect(events).toEqual(['grant', 'install']);
    expect(assets.list).not.toHaveBeenCalled();
    expect(assets.get).not.toHaveBeenCalled();
    expect(assets.getOrUpload).not.toHaveBeenCalled();
    const args =
      platform === 'ios' ?
        ['releases/app:42.zip', { launchMode: 'RelaunchIfRunning', md5: undefined }]
      : ['releases/app:42.zip'];
    if (daemon)
      expect(sendSessionCommand).toHaveBeenCalledWith(target.id, 'install-app-by-name', args, 120_000);
    else expect(device.installAppByName).toHaveBeenCalledWith(...args);
  });

  test.each([
    'asset:name/releases/app:42.zip:read',
    'asset:name/releases/*:read',
    'asset:*:read',
    'asset:*:all',
  ])('skips PATCH for %s', async (grant) => {
    const { command, update } = setup(platform, undefined, { 'asset-name': 'releases/app:42.zip' }, [grant]);
    await command.run();
    expect(update).not.toHaveBeenCalled();
  });

  test.each([true, false])('local uploads install by name, existing ID grant=%s', async (hasGrant) => {
    jest.mocked(ensureDaemonSession).mockResolvedValue(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-install-test-'));
    const file = path.join(dir, platform === 'ios' ? 'app.zip' : 'app.apk');
    fs.writeFileSync(file, 'app fixture');
    try {
      const { command, assets, device, update } = setup(
        platform,
        file,
        { 'asset-ttl': '24h' },
        hasGrant ? ['asset:asset_test:read'] : [],
      );
      await command.run();
      expect(assets.getOrUpload).toHaveBeenCalledWith({ path: file, name: path.basename(file), ttl: '24h' });
      expect(device.installAppByName.mock.calls[0]?.[0]).toBe(path.basename(file));
      expect(update).toHaveBeenCalledTimes(hasGrant ? 0 : 1);
      expect(device.installApp).not.toHaveBeenCalled();
      expect(device.sendAsset).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([true, false])('URL installs preserve behavior with daemon=%s', async (daemon) => {
    jest.mocked(ensureDaemonSession).mockResolvedValue(daemon);
    const url = 'https://storage.example/app.zip';
    const { command, get, update, device, target } = setup(platform, url, {});
    await command.run();
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    if (daemon)
      expect(sendSessionCommand).toHaveBeenCalledWith(
        target.id,
        'install-app',
        platform === 'ios' ? [url, undefined] : [url],
        120_000,
      );
    else if (platform === 'ios') expect(device.installApp).toHaveBeenCalledWith(url, undefined);
    else expect(device.sendAsset).toHaveBeenCalledWith(url);
  });

  test('falls back to a direct connection for an older background session', async () => {
    jest.mocked(ensureDaemonSession).mockResolvedValue(true);
    const { command, device, disconnect } = setup(platform);
    jest.mocked(sendSessionCommand).mockRejectedValueOnce(new Error('Unknown command: install-app-by-name'));
    await command.run();
    expect(device.installAppByName).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  test('does not retry an installation failure through another connection', async () => {
    jest.mocked(ensureDaemonSession).mockResolvedValue(true);
    const { command, device } = setup(platform);
    jest.mocked(sendSessionCommand).mockRejectedValueOnce(new Error('asset read denied'));
    await expect(command.run()).rejects.toThrow('asset read denied');
    expect(device.installAppByName).not.toHaveBeenCalled();
  });

  test('denied delegation stops before connecting or installing', async () => {
    const { command, update, device } = setup(platform);
    update.mockRejectedValue(new Error('requested permissions exceed caller authority'));
    await expect(command.run()).rejects.toThrow('exceed caller authority');
    expect(ensureDaemonSession).not.toHaveBeenCalled();
    expect(device.installAppByName).not.toHaveBeenCalled();
  });

  test('rereads the role after a conflict and notices a concurrently added grant', async () => {
    const { command, update, live } = setup(platform);
    update.mockRejectedValueOnce(new APIError(412, {}, 'changed', new Headers()));
    live.mockResolvedValueOnce({
      data: { spec: { role: { permissions: [] } }, status: { state: 'ready' } },
      response: new Response(null, { headers: { etag: '"41"' } }),
    });
    live.mockResolvedValue({
      data: { spec: { role: { permissions: ['asset:*:read'] } }, status: { state: 'ready' } },
      response: new Response(null, { headers: { etag: '"42"' } }),
    });
    await command.run();
    expect(live).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
  });

  test.each(['releases/*.apk', 'appstore/Expo-Go.apk'])(
    'does not automatically grant broad access for %s',
    async (name) => {
      const { command, update } = setup(platform, undefined, { 'asset-name': name }, []);
      await expect(command.run()).rejects.toThrow(/pattern|explicitly/);
      expect(update).not.toHaveBeenCalled();
    },
  );

  test('catalog installs use an existing wildcard read grant', async () => {
    const { command, update } = setup(platform, undefined, { 'asset-name': 'appstore/Expo-Go.apk' }, [
      'asset:*:read',
    ]);
    await command.run();
    expect(update).not.toHaveBeenCalled();
  });

  test.each([undefined, './app.zip'])('requires one source, path=%s', async (source) => {
    const { command } = setup(platform, source, source ? { 'asset-name': 'app.zip' } : {});
    await expect(command.run()).rejects.toThrow('Provide a local path or URL, or --asset-name');
  });
});
