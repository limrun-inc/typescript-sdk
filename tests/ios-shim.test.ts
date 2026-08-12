import fs from 'fs';
import os from 'os';
import path from 'path';
import { startXcrunShimServer, type IosXcrunShimClient, type IosXcrunShimServer } from '@limrun/api/ios-shim';

const client = {
  deviceInfo: { udid: 'TEST-UDID' },
  listApps: async () => [],
  simctl: jest.fn(() => ({ wait: async () => ({ code: 0, stdout: '', stderr: '' }) })),
  syncApp: async () => ({}),
} as unknown as IosXcrunShimClient;

async function callShim(
  url: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args }),
  });
  return (await response.json()) as { code: number; stdout: string; stderr: string };
}

describe('xcrun shim server devicectl handling', () => {
  let server: IosXcrunShimServer;

  beforeAll(async () => {
    server = await startXcrunShimServer({ client, udid: 'TEST-UDID' });
  });

  afterAll(async () => {
    await server.close();
  });

  test('answers list devices with an empty device list, flags-before-subcommand order', async () => {
    // Maestro invokes `devicectl --json-output <path> list devices`.
    const jsonOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-shim-test-')), 'devices.json');
    const result = await callShim(server.url, ['devicectl', '--json-output', jsonOut, 'list', 'devices']);
    expect(result.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(jsonOut, 'utf8'))).toEqual({ result: { devices: [] } });
  });

  test('answers list devices on stdout when no --json-output is given', async () => {
    const result = await callShim(server.url, ['devicectl', 'list', 'devices']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ result: { devices: [] } });
  });

  test('rejects other devicectl subcommands', async () => {
    const result = await callShim(server.url, ['devicectl', 'device', 'install', 'app', 'App.ipa']);
    expect(result.code).toBe(127);
  });

  test('forwards simctl privacy to the remote simulator', async () => {
    const args = ['privacy', 'booted', 'grant', 'camera', 'com.example.app'];
    const result = await callShim(server.url, ['simctl', ...args]);
    expect(result.code).toBe(0);
    expect(client.simctl).toHaveBeenCalledWith(args);
  });
});
