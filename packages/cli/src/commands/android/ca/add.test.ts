import fs from 'fs';
import os from 'os';
import path from 'path';
import AndroidCaAdd from './add';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

jest.mock('../../../lib/instance-client-factory', () => ({ getAndroidInstanceClient: jest.fn() }));

function setup(pemPath: string) {
  const client = { addCaCertificate: jest.fn().mockResolvedValue({ filename: '8c1d60e6.0', sha256: 'ab' }) };
  const disconnect = jest.fn();
  jest.mocked(getAndroidInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const command = Object.assign(Object.create(AndroidCaAdd.prototype), {
    parse: async () => ({ args: { path: pemPath }, flags: { json: true, id: 'android_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveAndroidInstance: () => 'android_test',
    outputJson: jest.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect };
}

beforeEach(() => jest.clearAllMocks());

test('sends the PEM file to the instance and reports the stored certificate', async () => {
  const pemPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lim-ca-')), 'ca.pem');
  fs.writeFileSync(pemPath, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  const { command, client, disconnect } = setup(pemPath);
  await command.run();
  expect(client.addCaCertificate).toHaveBeenCalledWith(fs.readFileSync(pemPath, 'utf8'));
  expect(command.outputJson).toHaveBeenCalledWith({ filename: '8c1d60e6.0', sha256: 'ab' });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('refuses a missing file before connecting', async () => {
  const { command } = setup('/does/not/exist.pem');
  await expect(command.run()).rejects.toThrow('File not found: /does/not/exist.pem');
  expect(getAndroidInstanceClient).not.toHaveBeenCalled();
});
