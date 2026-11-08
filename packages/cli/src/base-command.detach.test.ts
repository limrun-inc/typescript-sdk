import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import { BaseCommand } from './base-command';
import { clearLastInstanceId } from './lib/config';
import { stopDaemon } from './lib/daemon';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  clearLastInstanceId: jest.fn(),
}));
jest.mock('./lib/daemon', () => ({
  ...jest.requireActual('./lib/daemon'),
  stopDaemon: jest.fn(),
}));

class DetachCommand extends BaseCommand {
  async run(): Promise<void> {}

  detach(id: string, fn: () => Promise<unknown>) {
    (this as unknown as { _lastResolvedInstanceId: string })._lastResolvedInstanceId = id;
    return this.withAuth(fn, { createReplacement: false });
  }
}

const originalFetch = nodeProxyTransport.fetch;
afterEach(() => {
  nodeProxyTransport.fetch = originalFetch;
  jest.clearAllMocks();
});

test.each(['xcode', 'gradle'] as const)('%s detach keeps a remembered sandbox on route 404', async (kind) => {
  nodeProxyTransport.fetch = jest.fn(async () => new Response('not found', { status: 404 }));
  const lim = new Limrun({ apiKey: 'test-key' });
  const target = { apiUrl: 'https://sandbox.example.test', token: 'sandbox-token' };
  const detach =
    kind === 'xcode' ?
      (await lim.xcodeInstances.createClient(target)).detachSimulator
    : (await lim.gradleInstances.createClient(target)).detachEmulator;
  const command = new DetachCommand([], {} as never);
  await expect(command.detach('sandbox_euna_remembered', detach)).rejects.toThrow(
    'may predate detach support',
  );
  expect(clearLastInstanceId).not.toHaveBeenCalled();
  expect(stopDaemon).not.toHaveBeenCalled();
  expect(nodeProxyTransport.fetch).toHaveBeenCalledTimes(1);
});
