// @vitest-environment node
import { beforeEach, expect, test, vi } from 'vitest';
import { AppleRelayError } from './relay';
import { startBrowserOwnedAppleIDLogin } from './login';

const relay = vi.hoisted(() => ({
  relaySessionId: '0123456789abcdef0123456789abcdef',
  request: vi.fn(),
  close: vi.fn(),
}));
vi.mock('./relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./relay')>()),
  openAppleRelayWebSocket: vi.fn().mockResolvedValue(relay),
}));
vi.mock('./gsa-srp', () => ({
  AppleGsaSrpClient: class {
    async init() {
      return {};
    }
    async complete() {
      return {};
    }
  },
}));
const input = {
  registryApiUrl: 'https://registry.example.com',
  accountName: 'test@example.com',
  password: 'test-password',
};
beforeEach(() => vi.clearAllMocks());

test('failed login preserves the support reference after closing the relay', async () => {
  relay.request
    .mockResolvedValueOnce({ status: 200, body: {} })
    .mockResolvedValueOnce({ status: 401, rawBody: '{"serviceErrors":[{"code":"-20209"}]}' });
  await expect(startBrowserOwnedAppleIDLogin(input)).rejects.toMatchObject({
    name: 'AppleRelayError',
    relaySessionId: relay.relaySessionId,
  });
  expect(relay.close).toHaveBeenCalledOnce();
});

test('two-factor failures retain the same reference', async () => {
  relay.request
    .mockResolvedValueOnce({ status: 200, body: {} })
    .mockResolvedValueOnce({ status: 409 })
    .mockResolvedValueOnce({ status: 200, body: {} })
    .mockResolvedValueOnce({ status: 401 });
  const login = await startBrowserOwnedAppleIDLogin(input);
  await expect(login.finishTwoFactor('123456')).rejects.toMatchObject({
    name: 'AppleRelayError',
    relaySessionId: relay.relaySessionId,
  });
});

test('transport errors retain their original reference', async () => {
  const failure = new AppleRelayError('Connection closed', relay.relaySessionId);
  relay.request.mockRejectedValueOnce(failure);
  await expect(startBrowserOwnedAppleIDLogin(input)).rejects.toBe(failure);
});
