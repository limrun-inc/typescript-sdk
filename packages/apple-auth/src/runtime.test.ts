// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { AppleGsaSrpClient } from './gsa-srp';
import { generateAppleSigningKeyAndCSR } from './crypto';
import { openAppleRelayWebSocket } from './relay';
import { startAppleIDLogin, startBrowserOwnedAppleIDLogin } from './login';

afterEach(() => vi.unstubAllGlobals());

test('SRP proofs and signing keys work without browser globals', async () => {
  vi.stubGlobal('crypto', undefined);
  vi.stubGlobal('self', undefined);
  const client = new AppleGsaSrpClient('developer@example.com');
  expect((await client.init()).a.length).toBeGreaterThan(100);
  const proof = await client.complete('test-password', {
    iteration: 1000,
    salt: btoa('test-salt'),
    protocol: 's2k',
    b: btoa('\x02'),
    c: 'challenge',
  });
  expect(proof.m1).toHaveLength(44);
  expect(proof.m2).toHaveLength(44);
  const key = await generateAppleSigningKeyAndCSR({ commonName: 'Runtime test' });
  expect(key.csrPEM).toContain('BEGIN CERTIFICATE REQUEST');
  expect(globalThis.crypto).toBeUndefined();
  expect(startBrowserOwnedAppleIDLogin).toBe(startAppleIDLogin);
});

test('the relay uses the Node WebSocket fallback without changing globals', async () => {
  vi.stubGlobal('WebSocket', undefined);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) =>
    socket.on('message', (message) => {
      const { id } = JSON.parse(String(message));
      socket.send(JSON.stringify({ id, ok: true, response: { status: 200, body: { authenticated: true } } }));
    }),
  );
  const address = server.address();
  if (typeof address === 'string') throw new Error('Expected TCP listener');
  const relay = await openAppleRelayWebSocket(`http://127.0.0.1:${address.port}`);
  try {
    expect((await relay.request('finalize')).body).toEqual({ authenticated: true });
    expect(globalThis.WebSocket).toBeUndefined();
  } finally {
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
