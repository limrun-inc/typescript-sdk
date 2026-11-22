import { Parser } from '@oclif/core';
import SupportCreate from './create';

async function requestKey(subject: string, message: string, ...extra: string[]): Promise<string> {
  const argv = ['--org', 'org_example', '--subject', subject, '--message', message, ...extra];
  const post = jest.fn().mockResolvedValue({ id: 'ticket_example' });
  const command = Object.assign(Object.create(SupportCreate.prototype), {
    parse: () => Parser.parse(argv, { flags: SupportCreate.flags }),
    setParsedFlags: jest.fn(),
    withAuth: (run: () => Promise<void>) => run(),
    outputResult: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: { post } });
  await command.run();
  const [path, { body, headers }] = post.mock.calls[0]!;
  expect(path).toBe('/v1/organizations/org_example/support_tickets');
  expect(body).toEqual({ kind: 'ticket', subject, message });
  return headers['Idempotency-Key'];
}

test('retries keep their payload-derived UUID across CLI invocations and versions', async () => {
  const subject = 'Release build failed';
  const message = 'Build 1842 failed during signing.';
  const key = '1fedaac0-3376-8e5f-8976-63c6cfbc5584';
  expect(await requestKey(subject, message)).toBe(key);
  expect(await requestKey(subject, message)).toBe(key);
  expect(await requestKey('Signing failed', message)).not.toBe(key);
  expect(await requestKey(subject, 'Build 1843 failed during signing.')).not.toBe(key);
});

test('an explicit event UUID takes precedence over the payload hash', async () => {
  const key = '11519c87-dfd9-45f3-ad9b-6b2fc0473da9';
  expect(await requestKey('Release failed', 'Signing failed.', '--idempotency-key', key)).toBe(key);
});
