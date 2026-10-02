import fs from 'fs';
import os from 'os';
import path from 'path';

const org = '12345678-1234-1234-1234-123456789abc';
const sessionId = 'mcpcli_01kkkkkkkkkkkkkkkkkkkkkkkk';
const apiEndpoint = 'https://eu-staging.limrun.dev';
const authEndpoint = 'https://api-staging.limrun.dev';
const consoleEndpoint = 'https://console-staging.limrun.dev';
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let temp: string;
let savedEnv: NodeJS.ProcessEnv;
let login: typeof import('./mcp-login');
let connection: typeof import('./mcp-connection');
let config: typeof import('./config');

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-mcp-test-'));
  savedEnv = { ...process.env };
  delete process.env['LIM_API_KEY'];
  delete process.env['LIM_API_ENDPOINT'];
  delete process.env['LIM_CONSOLE_ENDPOINT'];
  process.env['LIM_WORKSPACE'] = 'pairing-test';
  jest.resetModules();
  jest.doMock('os', () => ({ ...jest.requireActual('os'), homedir: () => temp }));
  login = require('./mcp-login');
  connection = require('./mcp-connection');
  config = require('./config');
});
afterEach(() => {
  process.env = savedEnv;
  jest.dontMock('os');
  fs.rmSync(temp, { recursive: true, force: true });
});

async function begin() {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockResolvedValue(
    response(201, {
      sessionId,
      secret: 'private-collection-secret',
      phrase: 'amber apple',
      expiresAt: expiresAt(),
    }),
  );
  const output = await login.beginMCPLogin(
    { apiEndpoint, authEndpoint, consoleEndpoint, organizationId: org },
    'test',
    fetcher,
  );
  expect(JSON.stringify(output)).not.toContain('private-collection-secret');
  expect(new URL(String(fetcher.mock.calls[0]?.[0])).origin).toBe(authEndpoint);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).mcp).toBe(true);
  return output;
}

it('pairs into the exact workspace and environment without exposing credentials', async () => {
  await begin();
  config.writeConfig({ 'api-key': 'production-key', 'api-endpoint': 'https://api.limrun.com' });
  config.setLastInstance({ type: 'ios', id: 'ios_prod_previous' });
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(response(200, { apiKey: 'paired-key', organizationId: org, expiresAt: expiresAt() }));
  const output = await login.completeMCPLogin(sessionId, fetcher);
  expect(JSON.stringify(output)).not.toContain('paired-key');
  const requested = new URL(String(fetcher.mock.calls[0]?.[0]));
  expect(requested.origin).toBe(authEndpoint);
  expect(requested.searchParams.get('secret')).toBe('private-collection-secret');
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  expect(config.readConfig()).toMatchObject({
    apiKey: 'paired-key',
    apiEndpoint,
    consoleEndpoint,
    mcpPaired: true,
  });
  expect(fs.existsSync(path.join(temp, '.lim/mcp', `${sessionId}.json`))).toBe(false);
  expect(config.loadLastIosInstance()).toBeNull();
  process.env['LIM_WORKSPACE'] = 'other-project';
  expect(config.readConfig().apiKey).toBe('production-key');
});

it('refuses collection in a different workspace before making a request', async () => {
  await begin();
  process.env['LIM_WORKSPACE'] = 'other';
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  await expect(login.completeMCPLogin(sessionId, fetcher)).rejects.toThrow('same workspace');
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not save a key for another account', async () => {
  await begin();
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(
      response(200, { apiKey: 'wrong-account-key', organizationId: 'other', expiresAt: expiresAt() }),
    );
  await expect(login.completeMCPLogin(sessionId, fetcher)).rejects.toThrow('different account');
  expect(connection.loadMCPConnection()).toBeNull();
});

it('keeps a pending session for completion after MCP approval', async () => {
  await begin();
  const fetcher = jest
    .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
    .mockResolvedValue(response(202, {}));
  await expect(login.completeMCPLogin(sessionId, fetcher)).rejects.toThrow('not approved');
  expect(fs.existsSync(path.join(temp, '.lim/mcp', `${sessionId}.json`))).toBe(true);
});

it('fails closed on endpoint or credential overrides, expiry and logout', () => {
  const paired = {
    apiKey: 'paired-key',
    apiEndpoint,
    consoleEndpoint,
    organizationId: org,
    expiresAt: expiresAt(),
  };
  connection.saveMCPConnection(paired);
  config.writeConfig({ 'api-key': 'production-key' });
  for (const [name, value] of [
    ['LIM_API_ENDPOINT', 'https://api.limrun.com'],
    ['LIM_API_KEY', 'production-key'],
    ['LIM_CONSOLE_ENDPOINT', 'https://console.limrun.com'],
  ]) {
    process.env[name!] = value;
    expect(() => config.readConfig()).toThrow('conflict');
    delete process.env[name!];
  }
  connection.saveMCPConnection({ ...paired, expiresAt: new Date(0).toISOString() });
  expect(() => config.readConfig()).toThrow('expired');
  connection.saveMCPConnection(paired);
  config.clearApiKey();
  expect(() => config.readConfig()).toThrow('expired');
});

it('rejects insecure endpoints and path traversal session IDs', async () => {
  for (const endpoint of [
    'http://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/path',
    'https://api.example.test/?key=secret',
  ]) {
    expect(() => connection.validEndpoint(endpoint)).toThrow();
  }
  await expect(login.completeMCPLogin('../../config.yaml')).rejects.toThrow('Invalid MCP pairing');
});
