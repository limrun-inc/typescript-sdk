import Feedback from './commands/feedback';
import { readConfig } from './lib/config';

jest.mock('./lib/config', () => ({ ...jest.requireActual('./lib/config'), readConfig: jest.fn() }));

const initialExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = initialExitCode;
  jest.restoreAllMocks();
});

test('a signed-out customer can send feedback and receive a receipt', async () => {
  jest
    .mocked(readConfig)
    .mockReturnValue({ apiKey: '', apiEndpoint: 'https://example.test', consoleEndpoint: '' });
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { headers: { 'X-Limrun-Ticket-ID': 'ticket_test' } }));
  const output = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  await Feedback.run(['Login failed', '--email', 'guest@example.com', '--json']);
  expect(fetch.mock.calls[0]?.[0].toString()).toBe('https://example.test/feedback');
  const options = fetch.mock.calls[0]?.[1];
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
  expect(JSON.parse(String(options?.body))).toMatchObject({
    message: 'Login failed',
    email: 'guest@example.com',
    source: 'cli',
  });
  expect([...output.mock.calls, ...log.mock.calls].flat().join('')).toContain('ticket_test');
});

test('a denied credential never falls back to guest submission', async () => {
  jest
    .mocked(readConfig)
    .mockReturnValue({ apiKey: 'lim_invalid', apiEndpoint: 'http://127.0.0.1:1', consoleEndpoint: '' });
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ message: 'Access denied' }, { status: 403 }));
  await expect(Feedback.run(['Login failed'])).rejects.toThrow(/Access denied.*--request-id [0-9a-f-]{36}/s);
  expect(fetch).toHaveBeenCalled();
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/feedback'))).toBe(false);
});

test('a guest sees why a request was rejected', async () => {
  jest
    .mocked(readConfig)
    .mockReturnValue({ apiKey: '', apiEndpoint: 'https://example.test', consoleEndpoint: '' });
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ message: 'provide a personal reply address' }, { status: 400 }));
  await expect(Feedback.run(['Login failed', '--guest'])).rejects.toThrow(
    'Guest support returned HTTP 400. provide a personal reply address',
  );
});

test('a failed organization write reports the idempotency key it sent', async () => {
  jest
    .mocked(readConfig)
    .mockReturnValue({ apiKey: 'lim_test', apiEndpoint: 'https://example.test', consoleEndpoint: '' });
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ organization: { id: 'org_test' } }))
    .mockResolvedValueOnce(Response.json({ message: 'Access denied' }, { status: 403 }));
  const failure = await Feedback.run(['Login failed']).catch((err: Error) => err);
  const requestId = new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Idempotency-Key');
  expect(requestId).toBeTruthy();
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(`--request-id ${requestId}`);
});
