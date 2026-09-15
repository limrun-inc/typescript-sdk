import { parseToolRequests } from '../src/mise-tools';

test('preserves requested tool names and versions for server interpretation', () => {
  expect(parseToolRequests(['nodejs@24.5.0', 'ruby@3.3.7', 'pnpm@10.12.1', 'mint@0.18.0'])).toEqual({
    nodejs: '24.5.0',
    ruby: '3.3.7',
    pnpm: '10.12.1',
    mint: '0.18.0',
  });
  expect(parseToolRequests(['ruby@3'])).toEqual({ ruby: '3' });
  expect(parseToolRequests(['node@latest'])).toEqual({ node: 'latest' });
  expect(parseToolRequests(['jdk@jbr-21.0.11+1163.116'])).toEqual({ jdk: 'jbr-21.0.11+1163.116' });
  expect(parseToolRequests(['node@lts', 'swift@6'])).toEqual({ node: 'lts', swift: '6' });
});

test.each(['node', '@24', 'node@', 'node@ ', "node';echo@24"])('rejects malformed request %s', (request) => {
  expect(() => parseToolRequests([request])).toThrow();
});
