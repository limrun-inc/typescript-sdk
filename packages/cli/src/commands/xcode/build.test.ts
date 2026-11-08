import { Parser } from '@oclif/core';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import XcodeBuild from './build';
import os from 'node:os';
import { LocalSecretStore } from '../../lib/local-secret-store';

const directory = mkdtempSync(join(tmpdir(), 'lim-appstore-test-'));
const keyPath = join(directory, 'AuthKey.p8');
const certificatePath = join(directory, 'certificate.p12');
const profilePath = join(directory, 'app.mobileprovision');
writeFileSync(keyPath, 'fixture-private-key');
writeFileSync(certificatePath, 'fixture-certificate');
writeFileSync(profilePath, 'fixture-profile');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const parse = (argv: string[]) => Parser.parse(argv, { flags: XcodeBuild.flags });

test.each(['', ' '])('rejects an empty app ID %j', async (appID) => {
  await expect(parse(['--upload-to-appstore', '--asc-app-id', appID])).rejects.toThrow(
    /asc-app-id must not be empty/,
  );
});

test.each([
  { argv: ['--asc-app-id', '6822100611'], error: /asc-app-id requires --upload-to-appstore/ },
  {
    argv: ['--ios', '--upload-to-appstore', '--asc-app-id', '6822100611'],
    error: /cannot upload to App Store Connect/,
  },
])('rejects invalid upload flags before authenticating: $argv', async ({ argv, error }) => {
  const parsed = await parse(argv);
  const withAuth = jest.fn();
  const command = Object.assign(Object.create(XcodeBuild.prototype), {
    parse: async () => ({ ...parsed, args: {} }),
    setParsedFlags: jest.fn(),
    withAuth,
    error: (message: string) => {
      throw new Error(message);
    },
  });
  await expect(command.run()).rejects.toThrow(error);
  expect(withAuth).not.toHaveBeenCalled();
});

describe.each(['iphoneos', 'appletvos', 'xros'])('%s App Store upload', (sdk) => {
  test.each([undefined, '6822100611'])('passes app ID %j to the SDK', async (appID) => {
    const { flags } = await parse([
      '--sdk',
      sdk,
      '--upload-to-appstore',
      '--asc-key-id',
      'KEY123',
      '--asc-key',
      keyPath,
      '--certificate-p12',
      certificatePath,
      '--certificate-password',
      'password',
      '--provisioning-profile',
      profilePath,
      ...(appID ? ['--asc-app-id', appID] : []),
    ]);
    const proc = Object.assign(Promise.resolve({ exitCode: 0 }), {
      command: { on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    });
    const xcodebuild = jest.fn(() => proc);
    const command = Object.assign(Object.create(XcodeBuild.prototype), {
      parse: async () => ({ args: { path: directory }, flags }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      resolveXcodeTargetOrCreate: async () => ({ type: 'xcode', id: 'sandbox_test' }),
      applyBuildCacheToTarget: jest.fn(),
      resolveXcodeClientForWork: async () => ({ sync: async () => ({ bytesSent: 0 }), xcodebuild }),
      info: jest.fn(),
      isJsonEnabled: () => true,
      outputEvent: jest.fn(),
    });
    await command.run();
    expect(xcodebuild).toHaveBeenCalledWith(
      expect.objectContaining({ sdk }),
      expect.objectContaining({
        appstore: {
          ...(appID && { appId: appID }),
          apiKeyId: 'KEY123',
          apiPrivateKeyBase64: Buffer.from('fixture-private-key').toString('base64'),
        },
      }),
    );
  });
});

test.each([false, true])('passes expo-no-clean=%s to the SDK', async (noClean) => {
  const { flags } = await parse(noClean ? ['--expo-no-clean'] : []);
  const proc = Object.assign(Promise.resolve({ exitCode: 0 }), {
    command: { on: jest.fn() },
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
  });
  const xcodebuild = jest.fn((_config: unknown, _options: import('@limrun/api').XcodeBuildOptions) => proc);
  const command = Object.assign(Object.create(XcodeBuild.prototype), {
    parse: async () => ({ args: { path: directory }, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveXcodeTargetOrCreate: async () => ({ type: 'xcode', id: 'sandbox_test' }),
    applyBuildCacheToTarget: jest.fn(),
    resolveXcodeClientForWork: async () => ({ sync: async () => ({ bytesSent: 0 }), xcodebuild }),
    info: jest.fn(),
    isJsonEnabled: () => true,
    outputEvent: jest.fn(),
  });
  await command.run();
  expect(xcodebuild).toHaveBeenCalledTimes(1);
  expect(xcodebuild.mock.calls[0]?.[1]?.reactNative).toEqual(noClean ? { expoNoClean: true } : undefined);
});

test('rejects expo-no-clean with XcodeGen before authenticating', async () => {
  const parsed = await parse(['--expo-no-clean', '--xcodegen-spec', 'project.yml']);
  const withAuth = jest.fn();
  const command = Object.assign(Object.create(XcodeBuild.prototype), {
    parse: async () => ({ ...parsed, args: {} }),
    setParsedFlags: jest.fn(),
    withAuth,
    error: (message: string) => {
      throw new Error(message);
    },
  });
  await expect(command.run()).rejects.toThrow(/cannot be combined with Expo/);
  expect(withAuth).not.toHaveBeenCalled();
});

// A missing upload login must fail before creating a billed Xcode instance.
test.each([undefined, 'MISSING'])(
  'rejects missing Apple credentials for team %j before instance work',
  async (teamID) => {
    const home = jest.spyOn(os, 'homedir').mockReturnValue(directory);
    try {
      const store = new LocalSecretStore();
      if (teamID)
        await store.put('appStoreConnectApiKey', 'TEAM/APP_STORE_CONNECT_API_KEY', {
          keyId: 'KEY',
          privateKeyP8Base64: 'private',
          teamID: 'TEAM',
        });
      const parsed = await parse(['--upload-to-appstore', ...(teamID ? ['--team-id', teamID] : [])]);
      const withAuth = jest.fn();
      const command = Object.assign(Object.create(XcodeBuild.prototype), {
        parse: async () => ({ ...parsed, args: {} }),
        setParsedFlags: jest.fn(),
        withAuth,
        error: (message: string) => {
          throw new Error(message);
        },
      });
      await expect(command.run()).rejects.toThrow('Run lim ios apple auth first');
      expect(withAuth).not.toHaveBeenCalled();
    } finally {
      rmSync(join(directory, '.lim'), { recursive: true, force: true });
      home.mockRestore();
    }
  },
);

test('an empty team flag uses the saved team in the cloud signing request', async () => {
  const home = jest.spyOn(os, 'homedir').mockReturnValue(directory);
  try {
    await new LocalSecretStore().put('appStoreConnectApiKey', 'TEAM/APP_STORE_CONNECT_API_KEY', {
      keyId: 'KEY',
      issuerId: 'ISSUER',
      privateKeyP8Base64: 'private',
      teamID: 'TEAM',
    });
    const { flags } = await parse(['--signing-method', 'app-store-connect', '--team-id', '']);
    const proc = Object.assign(Promise.resolve({ exitCode: 0 }), {
      command: { on: jest.fn() },
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
    });
    const xcodebuild = jest.fn(() => proc);
    const command = Object.assign(Object.create(XcodeBuild.prototype), {
      parse: async () => ({ args: { path: directory }, flags }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      resolveXcodeTargetOrCreate: async () => ({ type: 'xcode', id: 'sandbox_test' }),
      applyBuildCacheToTarget: jest.fn(),
      resolveXcodeClientForWork: async () => ({ sync: async () => ({ bytesSent: 0 }), xcodebuild }),
      info: jest.fn(),
      isJsonEnabled: () => true,
      outputEvent: jest.fn(),
    });
    await command.run();
    expect(xcodebuild).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudSigning: expect.objectContaining({ teamId: 'TEAM', apiKeyId: 'KEY' }),
      }),
    );
  } finally {
    rmSync(join(directory, '.lim'), { recursive: true, force: true });
    home.mockRestore();
  }
});
