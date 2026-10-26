import { Parser } from '@oclif/core';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import XcodeBuild from './build';

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
