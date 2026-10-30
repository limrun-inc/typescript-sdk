import Limrun from '../src';

describe.each(['xcode', 'ios'] as const)('%s snapshots', (kind) => {
  test('keeps paging information and encodes the exact key in get and delete', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = jest.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      return Response.json({ snapshots: [{ key: 'app-main' }], nextOffset: 25 });
    });
    const client = new Limrun({ apiKey: 'lim_test', baseURL: 'https://api.example', fetch: fetcher });
    const snapshots = kind === 'xcode' ? client.xcodeSnapshots : client.iosSnapshots;
    expect(await snapshots.list('org_test', { prefix: 'app_1%', limit: 25, offset: 0 })).toEqual({
      snapshots: [{ key: 'app-main' }],
      nextOffset: 25,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(`/v1/organizations/org_test/${kind}_snapshots`);
    expect(url.searchParams.get('prefix')).toBe('app_1%');
    expect(url.searchParams.get('limit')).toBe('25');
    const key = 'github.com/acme/mobile/main+debug%';
    await snapshots.get('org_test', key);
    await snapshots.delete('org_test', key);
    expect(calls[1]!.url).toContain(`${kind}_snapshots/github.com%2Facme%2Fmobile%2Fmain+debug%25`);
    expect(calls[2]!.url).toBe(calls[1]!.url);
    expect(calls[2]!.init?.method).toBe('DELETE');
    expect(new Headers(calls[2]!.init?.headers).get('Authorization')).toBe('Bearer lim_test');
  });

  test('preserves permission and not-found errors', async () => {
    const fetcher = jest.fn(async () => Response.json({ message: 'not allowed' }, { status: 403 }));
    const client = new Limrun({
      apiKey: 'lim_test',
      baseURL: 'https://api.example',
      fetch: fetcher,
      maxRetries: 0,
    });
    const snapshots = kind === 'xcode' ? client.xcodeSnapshots : client.iosSnapshots;
    await expect(snapshots.delete('org_test', 'app-main')).rejects.toBeInstanceOf(
      Limrun.PermissionDeniedError,
    );
    fetcher.mockImplementation(async () => Response.json({ message: 'not found' }, { status: 404 }));
    await expect(snapshots.get('org_test', 'app-main')).rejects.toBeInstanceOf(Limrun.NotFoundError);
  });
});
