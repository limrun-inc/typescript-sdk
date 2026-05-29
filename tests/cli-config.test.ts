import fs from 'fs';
import os from 'os';
import path from 'path';

import { type IosInstance } from '@limrun/api/resources/ios-instances';

async function withConfigModule<T>(
  fn: (config: typeof import('../packages/cli/src/lib/config')) => T,
): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-config-test-'));
  const homedir = () => homeDir;
  jest.resetModules();
  jest.doMock('os', () => {
    const actual = jest.requireActual<typeof import('os')>('os');
    return { ...actual, homedir, default: { ...actual, homedir } };
  });

  try {
    const config = await import('../packages/cli/src/lib/config');
    return fn(config);
  } finally {
    jest.dontMock('os');
    jest.resetModules();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function iosInstanceWithXcodeUrl(url?: string): IosInstance {
  return {
    metadata: {
      id: 'ios_euna_01test',
      createdAt: '2026-05-29T00:00:00Z',
      organizationId: 'org_123',
      displayName: 'Sample app session',
    },
    spec: {
      region: 'eu-north-1',
      inactivityTimeout: '3m',
      hardTimeout: '30m',
    },
    status: {
      state: 'ready',
      apiUrl: 'https://ios.example.test',
      token: 'lim_ios_token',
      ...(url ? { sandbox: { xcode: { url } } } : {}),
    },
  };
}

describe('CLI last instance config', () => {
  test('registers the real sandbox Xcode target for iOS-owned Xcode sandboxes', async () => {
    await withConfigModule((config) => {
      const xcodeUrl = 'https://instances.example.test/sandbox_01xcode/api';
      config.registerCreatedInstance(iosInstanceWithXcodeUrl(xcodeUrl), ['xcode']);

      expect(config.loadLastIosInstance()).toMatchObject({
        id: 'ios_euna_01test',
        type: 'ios',
      });
      expect(config.loadLastXcodeInstance()).toMatchObject({
        id: 'sandbox_01xcode',
        type: 'xcode',
        apiUrl: xcodeUrl,
        token: 'lim_ios_token',
        metadata: {
          id: 'sandbox_01xcode',
          createdAt: '2026-05-29T00:00:00Z',
          organizationId: 'org_123',
          displayName: 'Sample app session',
        },
        spec: {
          region: 'eu-north-1',
          inactivityTimeout: '3m',
          hardTimeout: '30m',
        },
        status: {
          state: 'ready',
          apiUrl: xcodeUrl,
          token: 'lim_ios_token',
        },
      });
    });
  });

  test('clears the derived sandbox Xcode target when the owning iOS instance is cleared', async () => {
    await withConfigModule((config) => {
      config.registerCreatedInstance(
        iosInstanceWithXcodeUrl('https://instances.example.test/sandbox_01xcode/api'),
        ['xcode'],
      );

      config.clearLastInstanceId('ios_euna_01test');

      expect(config.loadLastIosInstance()).toBeNull();
      expect(config.loadLastXcodeInstance()).toBeNull();
    });
  });

  test('keeps legacy iOS xcode slot behavior when no sandbox URL is available', async () => {
    await withConfigModule((config) => {
      config.registerCreatedInstance(iosInstanceWithXcodeUrl(), ['xcode']);

      expect(config.loadLastXcodeInstance()).toMatchObject({
        id: 'ios_euna_01test',
        type: 'ios',
      });
    });
  });

  test('keeps legacy iOS xcode slot behavior when sandbox URL cannot be parsed', async () => {
    await withConfigModule((config) => {
      config.registerCreatedInstance(
        iosInstanceWithXcodeUrl('https://instances.example.test/no-sandbox-id'),
        ['xcode'],
      );

      expect(config.loadLastXcodeInstance()).toMatchObject({
        id: 'ios_euna_01test',
        type: 'ios',
      });
    });
  });
});
