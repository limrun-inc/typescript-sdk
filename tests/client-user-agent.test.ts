import Limrun from '@limrun/api';
import { VERSION } from '../src/version';

const CLI_VERSION = require('../packages/cli/package.json').version;

describe('client User-Agent', () => {
  test.each([
    { userAgent: undefined, expected: `Limrun/JS ${VERSION}` },
    { userAgent: `lim/${CLI_VERSION}`, expected: `lim/${CLI_VERSION} Limrun/JS ${VERSION}` },
  ])('identifies SDK and CLI requests: $expected', async ({ userAgent, expected }) => {
    let received: Headers | undefined;
    const client = new Limrun({
      apiKey: 'lim_test_key',
      baseURL: 'https://api.example.test',
      userAgent,
      fetch: async (_input, init) => {
        received = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: 'test', token: 'test' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await client.accessTokens.create({ permissions: ['asset:*:read'] });

    expect(received?.get('User-Agent')).toBe(expected);
  });
});
