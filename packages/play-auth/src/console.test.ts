import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlayConsoleApp, enrollPlayAppSigning, PlayConsoleError } from './console';
const input = {
  accessToken: 'test-token',
  developerId: '1234567890123456789',
  packageName: 'com.example.test',
  title: 'Test app',
  defaultLanguage: 'en-US',
  appType: 'app' as const,
  paid: false,
  appMeetsGuidelines: true,
  usExportCompliant: true,
};
const app = { developerId: input.developerId, appId: '9876543210123456789' };
const wireApp = { '1': { '1': { '1': app.developerId }, '2': { '1': app.appId } } };
afterEach(() => vi.unstubAllGlobals());
describe('experimental Play Console operations', () => {
  it('creates a draft with explicit declarations, exact numeric IDs, and OAuth only', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wireApp)));
    vi.stubGlobal('fetch', mock);
    expect(await createPlayConsoleApp(input)).toEqual(app);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe(
      `https://playconsoleapps-pa.clients6.google.com/v1/developers/${input.developerId}:createAppV2`,
    );
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json+protobuf' },
    });
    expect(JSON.parse(init.body)).toEqual({
      '1': { '1': input.developerId },
      '2': 'Test app',
      '3': 'en-US',
      '4': 1,
      '5': false,
      '6': true,
      '7': true,
      '9': { '1': true },
      '11': 'com.example.test',
    });
  });
  it('supports paid games and passes cancellation to fetch', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wireApp)));
    vi.stubGlobal('fetch', mock);
    const controller = new AbortController();
    await createPlayConsoleApp({ ...input, appType: 'game', paid: true, signal: controller.signal });
    expect(JSON.parse(mock.mock.calls[0]![1].body)).toMatchObject({ '4': 2, '5': true });
    expect(mock.mock.calls[0]![1].signal).toBe(controller.signal);
  });
  it.each([
    { appMeetsGuidelines: false },
    { usExportCompliant: false },
    { developerId: '../other' },
    { accessToken: '' },
    { packageName: ' ' },
    { title: ' ' },
    { defaultLanguage: '' },
  ])('rejects invalid input before mutation: %j', async (invalid) => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(createPlayConsoleApp({ ...input, ...invalid })).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });
  it('enrolls an existing app without repeating creation', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mock);
    await enrollPlayAppSigning({ ...app, accessToken: input.accessToken });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe(
      `https://playconsoleapps-pa.clients6.google.com/v1/developers/${app.developerId}/apps/${app.appId}/appSigning:autoEnrollNewApp`,
    );
    expect(JSON.parse(mock.mock.calls[0]![1].body)).toEqual(wireApp);
  });
  it('explains approval and account permissions on 403 without leaking upstream data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret upstream details', { status: 403 })),
    );
    const error = await createPlayConsoleApp(input).catch((e) => e);
    expect(error).toBeInstanceOf(PlayConsoleError);
    expect(error).toMatchObject({ status: 403, outcomeUnknown: false });
    expect(error.message).toContain('play_console');
    expect(error.message).toContain('playdeveloperapp');
    expect(error.message).not.toContain('secret');
  });
  it.each(['network', 'server', 'invalid-json', 'wrong-account', 'numeric-id'])(
    'does not retry an ambiguous creation (%s)',
    async (mode) => {
      const mock = vi.fn();
      if (mode === 'network') mock.mockRejectedValue(new Error('test-token'));
      else if (mode === 'server') mock.mockResolvedValue(new Response('unknown result', { status: 503 }));
      else if (mode === 'invalid-json') mock.mockResolvedValue(new Response('not-json'));
      else
        mock.mockResolvedValue(
          new Response(
            JSON.stringify({
              '1': {
                '1': { '1': mode === 'wrong-account' ? '99' : input.developerId },
                '2': { '1': mode === 'numeric-id' ? 123 : app.appId },
              },
            }),
          ),
        );
      vi.stubGlobal('fetch', mock);
      const error = await createPlayConsoleApp(input).catch((e) => e);
      expect(error).toBeInstanceOf(PlayConsoleError);
      expect(error.outcomeUnknown).toBe(true);
      expect(error.message).not.toContain(input.accessToken);
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );
});
