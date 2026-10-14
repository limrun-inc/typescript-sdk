import { iosProxyToolError, parseProxyAddress } from './device-proxy';

test.each([
  ['localhost:3128', 'localhost', 3128],
  ['LocalHost:3128', 'localhost', 3128],
  ['10.0.0.5:8080', '10.0.0.5', 8080],
  ['Proxy.Acme.Internal:3128', 'proxy.acme.internal', 3128],
  ['proxy-1.corp:65535', 'proxy-1.corp', 65535],
])('parses %s', (value, host, port) => {
  expect(parseProxyAddress(value)).toEqual({ host, port });
});

test.each([
  'localhost',
  ':3128',
  'localhost:',
  'localhost:0',
  'localhost:65536',
  'localhost:+80',
  'localhost:3128x',
  '::1:3128',
  '[::1]:3128',
  'bad_host:3128',
  'a..b:3128',
  '1.2.3:3128',
  '010.0.0.1:3128',
  '-proxy.corp:3128',
  '*.corp:3128',
  `${'a.'.repeat(127)}aa:3128`,
])('rejects %s', (value) => {
  expect(() => parseProxyAddress(value)).toThrow('Pass it as host:port, for example localhost:3128.');
});

test.each([
  [
    'spawn supports only: spawn <device> defaults read|write|delete ..., spawn <device> notifyutil -p|-s|-g ...',
    'This instance does not support lim ios proxy yet. Create a new instance to use it.',
  ],
  ['limproxy is unavailable on this simulator', 'This simulator has no system proxy to set.'],
  ['limproxy: set proxy failed: SCError 1001\n', 'limproxy: set proxy failed: SCError 1001'],
  ['', 'limproxy failed with exit code 70'],
])('maps tool stderr %j', (stderr, message) => {
  expect(iosProxyToolError({ code: 70, stderr })).toBe(message);
});
