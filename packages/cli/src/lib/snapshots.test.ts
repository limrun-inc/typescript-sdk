import Limrun from '@limrun/api';
import { snapshotResource } from './snapshots';

test.each(['xcode', 'ios'] as const)(
  'uses the installed SDK transport for %s snapshot management',
  async (kind) => {
    const requests: { url: string; method: string }[] = [];
    const client = new Limrun({
      apiKey: 'lim_test',
      baseURL: 'https://api.example',
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET' });
        return init?.method === 'DELETE' ?
            new Response(null, { status: 200 })
          : Response.json({ snapshots: [], nextOffset: 25 });
      },
    });
    const snapshots = snapshotResource(client, kind, 'org_test');
    expect(await snapshots.list({ prefix: 'app_', limit: 25, offset: 0 })).toEqual({
      snapshots: [],
      nextOffset: 25,
    });
    await snapshots.get('app/main+debug');
    await snapshots.delete('app/main+debug');
    expect(new URL(requests[0]!.url).searchParams.get('prefix')).toBe('app_');
    expect(requests[1]!.url).toBe(
      `https://api.example/v1/organizations/org_test/${kind}_snapshots/app%2Fmain%2Bdebug`,
    );
    expect(requests[2]).toEqual({ url: requests[1]!.url, method: 'DELETE' });
  },
);

describe.each(['xcode', 'ios'] as const)('%s snapshot path validation', (kind) => {
  const fetch = jest.fn(async () => Response.json({}));
  const client = new Limrun({ apiKey: 'lim_test', baseURL: 'https://api.example', fetch });

  beforeEach(() => fetch.mockClear());

  test.each(['', '.', '..'])('rejects unsafe key %j before making a request', (key) => {
    const snapshots = snapshotResource(client, kind, 'org_test');
    expect(() => snapshots.get(key)).toThrow();
    expect(() => snapshots.delete(key)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['', '.', '..'])('rejects unsafe organization %j before making a request', (org) => {
    expect(() => snapshotResource(client, kind, org)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
