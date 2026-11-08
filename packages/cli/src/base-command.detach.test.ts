import Limrun, { NotFoundError } from '@limrun/api';
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
  probe = jest.fn<Promise<unknown>, [string]>();
  protected override get client(): BaseCommand['client'] {
    return {
      xcodeInstances: { get: this.probe },
      gradleInstances: { get: this.probe },
    } as unknown as BaseCommand['client'];
  }
  async run(): Promise<void> {}

  detach(id: string, type: 'xcode' | 'gradle', fn: () => Promise<unknown>) {
    (this as unknown as { _lastResolvedInstanceId: string })._lastResolvedInstanceId = id;
    return this.withAuth(() => this.detachDevice({ id, type }, fn), { createReplacement: false });
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
  await expect(command.detach('sandbox_euna_remembered', kind, detach)).rejects.toThrow(
    'may predate detach support',
  );
  expect(clearLastInstanceId).not.toHaveBeenCalled();
  expect(stopDaemon).not.toHaveBeenCalled();
  expect(nodeProxyTransport.fetch).toHaveBeenCalledTimes(1);
});

test.each(['xcode', 'gradle'] as const)('%s detach forgets a sandbox confirmed gone', async (kind) => {
  nodeProxyTransport.fetch = jest.fn(async () => new Response('not found', { status: 404 }));
  const lim = new Limrun({ apiKey: 'test-key' });
  const target = { apiUrl: 'https://sandbox.example.test', token: 'sandbox-token' };
  const detach =
    kind === 'xcode' ?
      (await lim.xcodeInstances.createClient(target)).detachSimulator
    : (await lim.gradleInstances.createClient(target)).detachEmulator;
  const command = new DetachCommand([], {} as never);
  command.probe.mockRejectedValue(new NotFoundError(404, {}, 'missing', new Headers()));
  await expect(command.detach('sandbox_euna_remembered', kind, detach)).rejects.toThrow(/not found/);
  expect(clearLastInstanceId).toHaveBeenCalledWith('sandbox_euna_remembered');
  expect(stopDaemon).toHaveBeenCalledWith('sandbox_euna_remembered');
  expect(command.probe).toHaveBeenCalledTimes(1);
});
