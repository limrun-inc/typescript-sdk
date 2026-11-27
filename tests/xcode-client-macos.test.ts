import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode client macOS helpers', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  async function xcodeClient() {
    return new Limrun({ apiKey: 'management-key' }).xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });
  }

  const attached = {
    attached: true,
    macos: { apiUrl: 'https://mac.example.test/v1/macos_abc/api', macosInstanceId: 'macos_abc' },
  };

  test('attaches a macOS instance with its apiUrl and control token', async () => {
    nodeProxyTransport.fetch = jest.fn(async () => jsonResponse(attached));
    const xcode = await xcodeClient();
    const macos = {
      metadata: { id: 'macos_abc' },
      status: { apiUrl: 'https://mac.example.test/v1/macos_abc/api', token: 'mac-token' },
    } as Parameters<typeof xcode.attachMacOS>[0];

    expect(await xcode.attachMacOS(macos)).toEqual(attached);
    expect(nodeProxyTransport.fetch).toHaveBeenCalledWith('https://xcode.example.test/macos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer xcode-token' },
      body: JSON.stringify({ apiUrl: 'https://mac.example.test/v1/macos_abc/api', token: 'mac-token' }),
    });
  });

  test('a macOS instance without a token cannot be attached', async () => {
    nodeProxyTransport.fetch = jest.fn();
    const xcode = await xcodeClient();
    const readOnly = {
      metadata: { id: 'macos_abc' },
      status: { apiUrl: 'https://mac.example.test/v1/macos_abc/api' },
    } as Parameters<typeof xcode.attachMacOS>[0];

    await expect(xcode.attachMacOS(readOnly)).rejects.toThrow('came back without its token');
    expect(nodeProxyTransport.fetch).not.toHaveBeenCalled();
  });

  test('reads and detaches the attachment through the sandbox', async () => {
    nodeProxyTransport.fetch = jest.fn(async (_input, init?: RequestInit) =>
      jsonResponse(init?.method === 'DELETE' ? { attached: false } : attached),
    );
    const xcode = await xcodeClient();

    expect((await xcode.getMacOS()).macos?.macosInstanceId).toBe('macos_abc');
    expect(await xcode.detachMacOS()).toEqual({ attached: false });
    expect(nodeProxyTransport.fetch).toHaveBeenLastCalledWith('https://xcode.example.test/macos', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer xcode-token' },
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
