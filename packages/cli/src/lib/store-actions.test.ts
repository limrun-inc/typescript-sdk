import { Command, Parser } from '@oclif/core';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withAppleSession, type AppleSessionContext } from './apple-session';
import { LocalSecretStore } from './local-secret-store';
import ListBundles from '../commands/ios/apple/list-bundle-ids';
import AssignGroups from '../commands/ios/apple/assign-app-groups';
import CreateApp from '../commands/ios/apple/create-app';
import FindApp from '../commands/ios/apple/find-app';
import CreateApiKey from '../commands/ios/apple/create-api-key';
import DownloadKey from '../commands/ios/apple/download-developer-key';
import RegenerateProfile from '../commands/ios/apple/regenerate-profile';
import EnrollSigning from '../commands/android/play/enroll-signing';
import Publish from '../commands/android/play/publish';
import GenerateKeystore from '../commands/android/play/generate-keystore';
import ExportKeystore from '../commands/android/play/export-keystore';

jest.mock('./apple-session', () => ({
  ...jest.requireActual('./apple-session'),
  withAppleSession: jest.fn(),
}));

function setup(CommandClass: typeof Command, argv: string[]) {
  const outputJson = jest.fn();
  const command = Object.assign(Object.create(CommandClass.prototype), {
    parse: () => Parser.parse(argv, { flags: CommandClass.flags }),
    setParsedFlags: jest.fn(),
    outputJson,
    withAuth: async (fn: () => Promise<unknown>) => fn(),
    error: (message: string) => {
      throw new Error(message);
    },
  });
  Object.defineProperty(command, 'client', {
    value: { apiKey: 'lim-test', accessTokens: { create: jest.fn(async () => ({ token: 'relay-token' })) } },
  });
  return { command, outputJson };
}

let directory: string;
let context: AppleSessionContext;
const request = jest.fn();
const originalFetch = global.fetch;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lim-store-actions-'));
  request.mockReset();
  context = {
    relay: { request } as unknown as AppleSessionContext['relay'],
    team: { teamId: 'TEAM', providerId: '123' },
    store: new LocalSecretStore(directory),
  };
  jest.mocked(withAppleSession).mockImplementation(async (_token, _flags, action) => action(context));
});
afterEach(async () => {
  global.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
});

test('bundle listing uses the selected team and Mac namespace without minting an Apple key', async () => {
  request.mockResolvedValue({
    status: 200,
    body: { appIds: [{ appIdId: 'A1', identifier: 'com.example.app', name: 'Example' }] },
  });
  const { command, outputJson } = setup(ListBundles, ['--platform', 'mac', '--search', 'example']);
  await command.run();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    'provisioning',
    expect.objectContaining({
      path: '/account/mac/identifiers/listAppIds.action',
      payload: expect.objectContaining({ teamId: 'TEAM' }),
    }),
  );
  expect(outputJson).toHaveBeenCalledWith([expect.objectContaining({ bundleId: 'com.example.app' })]);
});

test('App Store app creation switches provider before its single mutation', async () => {
  request
    .mockResolvedValueOnce({ status: 200, body: {} })
    .mockResolvedValueOnce({ status: 200, body: { data: { id: '456' } } });
  const { command, outputJson } = setup(CreateApp, ['--bundle-id', 'com.example.app', '--name', 'Example']);
  await command.run();
  expect(request.mock.calls[0]).toEqual([
    'appstoreconnect',
    expect.objectContaining({ path: '/olympus/v1/session', payload: { provider: { providerId: 123 } } }),
  ]);
  expect(request.mock.calls[1][1]).toMatchObject({
    path: '/iris/v1/apps',
    payload: { data: { attributes: { bundleId: 'com.example.app' } } },
  });
  expect(outputJson).toHaveBeenCalledWith({ id: '456', name: 'Example', bundleId: 'com.example.app' });
});

test('unknown providers fail before App Store Connect mutations', async () => {
  context.team = { teamId: 'TEAM' };
  await expect(
    setup(CreateApp, ['--bundle-id', 'com.example.app', '--name', 'Example']).command.run(),
  ).rejects.toThrow('provider ID');
  expect(request).not.toHaveBeenCalled();
});

test('assignment requires an explicit set or explicit clearing', async () => {
  await expect(setup(AssignGroups, ['--id', 'APP']).command.run()).rejects.toThrow('--resource-id');
  await expect(
    setup(AssignGroups, ['--id', 'APP', '--clear', '--resource-id', 'GROUP']).command.run(),
  ).rejects.toThrow('--resource-id');
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue({ status: 200, body: {} });
  await setup(AssignGroups, ['--id', 'APP', '--resource-id', 'OLD', '--resource-id', 'NEW']).command.run();
  expect(request.mock.calls[1][1].payload.applicationGroups).toEqual(['OLD', 'NEW']);
  request.mockClear();
  await setup(AssignGroups, ['--id', 'APP', '--clear']).command.run();
  expect(request.mock.calls[1][1].payload.applicationGroups).toEqual([]);
});

test('one-time private downloads refuse existing files without consuming the key', async () => {
  const output = path.join(directory, 'key.p8');
  await writeFile(output, 'existing');
  await expect(setup(DownloadKey, ['--id', 'KEY', '--output', output]).command.run()).rejects.toThrow(
    'EEXIST',
  );
  expect(request).not.toHaveBeenCalled();
  await rm(output);
  request.mockResolvedValue({ status: 200, rawBodyBase64: Buffer.from('private-key').toString('base64') });
  const { command, outputJson } = setup(DownloadKey, ['--id', 'KEY', '--output', output, '--json']);
  await command.run();
  expect(await readFile(output, 'utf8')).toBe('private-key');
  if (process.platform !== 'win32') expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(outputJson.mock.calls)).not.toContain('private-key');
});

test('profile regeneration rejects an empty development device set before a request', async () => {
  await expect(
    setup(RegenerateProfile, [
      '--id',
      'PROFILE',
      '--name',
      'Development',
      '--app-id',
      'APP',
      '--certificate-id',
      'CERT',
      '--distribution-type',
      'limited',
    ]).command.run(),
  ).rejects.toThrow('device ID');
  expect(request).not.toHaveBeenCalled();
});

test('Play signing enrollment targets an existing app without exposing its access token', async () => {
  const token = path.join(directory, 'token');
  await writeFile(token, 'private-token');
  const fetcher = jest.fn(async (_input: unknown, _init?: RequestInit) => Response.json({}));
  global.fetch = fetcher as typeof fetch;
  const { command, outputJson } = setup(EnrollSigning, [
    '--access-token-file',
    token,
    '--developer-id',
    '123',
    '--app-id',
    '456',
  ]);
  await command.run();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toContain('/developers/123/apps/456/appSigning:autoEnrollNewApp');
  expect(outputJson).toHaveBeenCalledWith({ ok: true, developerId: '123', appId: '456' });
  expect(JSON.stringify(outputJson.mock.calls)).not.toContain('private-token');
});

test('Play publishing validates production rollout and asset selection before calling the registry', async () => {
  const token = path.join(directory, 'token');
  await writeFile(token, 'private-token');
  const fetcher = jest.fn(async (_input: unknown, _init?: RequestInit) => Response.json({ versionCode: 17 }));
  global.fetch = fetcher as typeof fetch;
  const args = [
    '--access-token-file',
    token,
    '--asset-name',
    'app.aab',
    '--package-name',
    'com.example.app',
    '--track',
    'production',
  ];
  await expect(setup(Publish, args).command.run()).rejects.toThrow('release-status');
  expect(fetcher).not.toHaveBeenCalled();
  const { command, outputJson } = setup(Publish, [...args, '--release-status', 'draft']);
  await command.run();
  const [, init] = fetcher.mock.calls[0];
  expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
    accessToken: 'private-token',
    assetName: 'app.aab',
    track: 'production',
    releaseStatus: 'draft',
  });
  expect(outputJson).toHaveBeenCalledWith({ versionCode: 17 });
});

test('local keystore generation preserves existing keys and exports secrets only to files', async () => {
  const home = jest.spyOn(os, 'homedir').mockReturnValue(directory);
  try {
    const { command, outputJson } = setup(GenerateKeystore, ['--application-id', 'com.example.app']);
    await command.run();
    const saved = await new LocalSecretStore().get('androidSigningKey', 'com.example.app');
    expect(saved?.data.keystoreBase64).toBeTruthy();
    expect(JSON.stringify(outputJson.mock.calls)).not.toContain(saved!.data.keystorePassword);
    await expect(command.run()).rejects.toThrow('already exists');
    expect(await new LocalSecretStore().get('androidSigningKey', 'com.example.app')).toEqual(saved);
    const output = path.join(directory, 'upload.p12');
    const credentials = path.join(directory, 'credentials.json');
    const exported = setup(ExportKeystore, [
      '--application-id',
      'com.example.app',
      '--output',
      output,
      '--credentials-output',
      credentials,
    ]);
    await exported.command.run();
    expect((await readFile(output)).toString('base64')).toBe(saved!.data.keystoreBase64);
    expect(JSON.parse(await readFile(credentials, 'utf8')).keystorePassword).toBe(
      saved!.data.keystorePassword,
    );
    expect(JSON.stringify(exported.outputJson.mock.calls)).not.toContain(saved!.data.keystorePassword);
  } finally {
    home.mockRestore();
  }
});

test('app lookup reports an absent app explicitly', async () => {
  request
    .mockResolvedValueOnce({ status: 200, body: {} })
    .mockResolvedValueOnce({ status: 200, body: { data: [] } });
  const { command, outputJson } = setup(FindApp, ['--bundle-id', 'com.example.absent']);
  await command.run();
  expect(outputJson).toHaveBeenCalledWith({ app: null });
});

test('API key creation preserves requested roles and visibility', async () => {
  request
    .mockResolvedValueOnce({ status: 200, body: {} })
    .mockResolvedValueOnce({ status: 200, body: { data: { id: 'KEY' } } });
  await setup(CreateApiKey, [
    '--nickname',
    'Release key',
    '--role',
    'DEVELOPER',
    '--no-all-apps-visible',
  ]).command.run();
  expect(request.mock.calls[1][1].payload.data.attributes).toMatchObject({
    roles: ['DEVELOPER'],
    allAppsVisible: false,
  });
});
