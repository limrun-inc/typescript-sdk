import { androidBlockedDomainsUrl, requestBlockedDomains } from '../src/internal/blocked-domains';
import { nodeProxyTransport } from '../src/internal/proxy-transport';

describe('blocked domains', () => {
  afterEach(() => jest.restoreAllMocks());

  test('the Android endpoint sits on websocket-proxy behind the ADB URL', () => {
    expect(androidBlockedDomainsUrl('wss://host.example/android_x/adbWebSocket')).toMatch(
      /^https:\/\/host\.example\/.*blocked-domains$/,
    );
  });

  test('a list replaces the blocked domains and returns the canonical one', async () => {
    const fetch = jest
      .spyOn(nodeProxyTransport, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ domains: ['facebook.com'] }), { status: 200 }));
    await expect(
      requestBlockedDomains('https://pod/blocked-domains', 'tok', ['Facebook.com']),
    ).resolves.toEqual(['facebook.com']);
    expect(fetch).toHaveBeenCalledWith('https://pod/blocked-domains', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: ['Facebook.com'] }),
    });
  });

  test('no list reads the blocked domains', async () => {
    const fetch = jest
      .spyOn(nodeProxyTransport, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ domains: [] }), { status: 200 }));
    await expect(requestBlockedDomains('https://pod/blocked-domains', 'tok')).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith('https://pod/blocked-domains', {
      method: 'GET',
      headers: { Authorization: 'Bearer tok' },
    });
  });

  test('a refusal carries the pod reason', async () => {
    jest.spyOn(nodeProxyTransport, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'blocked domains take no port, so use facebook.com' }), {
        status: 400,
      }),
    );
    await expect(
      requestBlockedDomains('https://pod/blocked-domains', 'tok', ['facebook.com:443']),
    ).rejects.toThrow(
      'Setting the blocked domains failed (400): blocked domains take no port, so use facebook.com',
    );
  });
});
