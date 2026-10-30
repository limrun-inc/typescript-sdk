import Save from './save';
import Restore from './restore';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ getIosInstanceClient: jest.fn() }));

const asset = {
  id: 'asset_test',
  name: 'keychain/login.tar.gz',
  kind: 'Keychain',
  signedUploadUrl: 'https://assets.example/upload',
  signedDownloadUrl: 'https://assets.example/download',
};

function setup(commandClass: typeof Save | typeof Restore) {
  const command = Object.assign(Object.create(commandClass.prototype), {
    parse: async () => ({ args: {}, flags: { json: true } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    outputJson: jest.fn(),
  });
  const assets = { list: jest.fn(), getOrCreate: jest.fn().mockResolvedValue(asset) };
  Object.defineProperty(command, 'client', { value: { assets } });
  const client = {
    saveKeychain: jest.fn().mockResolvedValue(undefined),
    restoreKeychain: jest.fn().mockResolvedValue({ durationMs: 42 }),
  };
  const disconnect = jest.fn();
  jest
    .mocked(getIosInstanceClient)
    .mockResolvedValue({ client, disconnect } as unknown as Awaited<ReturnType<typeof getIosInstanceClient>>);
  return { command, assets, client, disconnect };
}

test('save uploads the keychain and returns the asset without a generated key', async () => {
  const { command, assets, client, disconnect } = setup(Save);
  assets.list.mockResolvedValue([]);
  await command.run();
  expect(assets.getOrCreate).toHaveBeenCalledWith({
    name: asset.name,
    kind: 'Keychain',
    platform: 'ios',
    ttl: undefined,
  });
  expect(client.saveKeychain).toHaveBeenCalledWith({ url: asset.signedUploadUrl });
  expect(command.outputJson).toHaveBeenCalledWith(asset);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('restore resolves the default asset and applies it without a key', async () => {
  const { command, assets, client, disconnect } = setup(Restore);
  assets.list.mockResolvedValue([asset]);
  await command.run();
  expect(assets.list).toHaveBeenCalledWith({
    nameFilter: asset.name,
    kindFilter: 'Keychain',
    includeDownloadUrl: true,
  });
  expect(client.restoreKeychain).toHaveBeenCalledWith({ url: asset.signedDownloadUrl });
  expect(command.outputJson).toHaveBeenCalledWith({ durationMs: 42 });
  expect(disconnect).toHaveBeenCalledTimes(1);
});
