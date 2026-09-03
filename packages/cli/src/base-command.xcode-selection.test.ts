import { NotFoundError, XcodeSelectionUnsupportedError } from '@limrun/api';
import { BaseCommand } from './base-command';
import { clearLastInstanceId, LastIosInstance, LastXcodeInstance } from './lib/config';
import { stopDaemon } from './lib/daemon';

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  clearLastInstanceId: jest.fn(),
}));
jest.mock('./lib/daemon', () => ({
  ...jest.requireActual('./lib/daemon'),
  stopDaemon: jest.fn(),
}));

const clearLastInstanceIdMock = clearLastInstanceId as jest.MockedFunction<typeof clearLastInstanceId>;
const stopDaemonMock = stopDaemon as jest.MockedFunction<typeof stopDaemon>;

class TestCommand extends BaseCommand {
  infoLines: string[] = [];
  probe = jest.fn<Promise<unknown>, [string]>();

  async run(): Promise<void> {}

  protected override info(message = ''): void {
    this.infoLines.push(message);
  }

  protected override get client(): BaseCommand['client'] {
    return { xcodeInstances: { get: this.probe } } as unknown as BaseCommand['client'];
  }

  markCreated(id: string): void {
    this._instancesCreatedThisRun.add(id);
  }

  read<T>(target: LastXcodeInstance | LastIosInstance, remembered: boolean, call: () => Promise<T>) {
    return this.readXcodeSelectionOrForget(target, remembered, call);
  }

  refusal(err: unknown) {
    return this.xcodeRefusal(err);
  }
}

const target: LastXcodeInstance = { id: 'sandbox_euna_gone', type: 'xcode' };
const unsupported = () => new XcodeSelectionUnsupportedError('GET /xcode');
const notFound = () => new NotFoundError(404, { message: 'not found' }, undefined, new Headers());
const daemonError = (status: number, body: string): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status, body });

describe('readXcodeSelectionOrForget', () => {
  beforeEach(() => {
    clearLastInstanceIdMock.mockReset();
    stopDaemonMock.mockReset();
    delete process.env.LIM_XCODE_INSTANCE_URL;
    delete process.env.LIM_XCODE_INSTANCE_TOKEN;
  });

  it('forgets a remembered sandbox the API no longer knows instead of calling its daemon old', async () => {
    // The remembered sandbox was deleted (idle timeout, another machine). Its cached URL yields a
    // 404 that the SDK phrases as "daemon predates selection"; the API says gone.
    const cmd = new TestCommand([], {} as never);
    cmd.probe.mockRejectedValue(notFound());
    await expect(cmd.read(target, true, () => Promise.reject(unsupported()))).resolves.toBeUndefined();
    expect(cmd.probe).toHaveBeenCalledWith(target.id);
    expect(stopDaemonMock).toHaveBeenCalledWith(target.id);
    expect(clearLastInstanceIdMock).toHaveBeenCalledWith(target.id);
    expect(cmd.infoLines.join('\n')).toContain('no longer exists');
  });

  it('reports a vanished sandbox named explicitly as not found, not as "no sandbox"', async () => {
    const cmd = new TestCommand([], {} as never);
    cmd.probe.mockRejectedValue(notFound());
    await expect(cmd.read(target, false, () => Promise.reject(unsupported()))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(clearLastInstanceIdMock).not.toHaveBeenCalled();
  });

  it('checks the sandbox behind a simulator-backed target and keeps the simulator', async () => {
    // The simulator is alive; only its child sandbox is gone (deleted, or being recreated by its
    // owner). Neither a NotFoundError (withAuth would forget and replace the simulator) nor a
    // silent forget is right: the user is told which sandbox is gone and the memory stays.
    const ios: LastIosInstance = {
      id: 'ios_euna_live',
      type: 'ios',
      sandboxXcodeUrl: 'https://euna.limrun.net/v1/sandbox_euna_child/xcode',
    };
    const cmd = new TestCommand([], {} as never);
    cmd.probe.mockRejectedValue(notFound());
    const err = await cmd.read(ios, true, () => Promise.reject(unsupported())).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain('sandbox_euna_child');
    expect((err as Error).message).toContain('ios_euna_live');
    expect(cmd.probe).toHaveBeenCalledWith('sandbox_euna_child');
    expect(clearLastInstanceIdMock).not.toHaveBeenCalled();
    expect(stopDaemonMock).not.toHaveBeenCalled();
  });

  it('keeps the unsupported error when the sandbox is alive', async () => {
    const cmd = new TestCommand([], {} as never);
    cmd.probe.mockResolvedValue({ metadata: { id: target.id } });
    await expect(cmd.read(target, true, () => Promise.reject(unsupported()))).rejects.toBeInstanceOf(
      XcodeSelectionUnsupportedError,
    );
    expect(clearLastInstanceIdMock).not.toHaveBeenCalled();
  });

  it('takes a sandbox this run created, or an env-pinned one, at its word', async () => {
    const cmd = new TestCommand([], {} as never);
    cmd.markCreated(target.id);
    await expect(cmd.read(target, true, () => Promise.reject(unsupported()))).rejects.toBeInstanceOf(
      XcodeSelectionUnsupportedError,
    );
    process.env.LIM_XCODE_INSTANCE_URL = 'https://euna.limrun.net/v1/sandbox_euna_pinned/xcode';
    process.env.LIM_XCODE_INSTANCE_TOKEN = 'opaque-token';
    const pinned = new TestCommand([], {} as never);
    const envTarget = (await import('./lib/set-instance')).envInstanceTarget('xcode')!;
    await expect(pinned.read(envTarget, false, () => Promise.reject(unsupported()))).rejects.toBeInstanceOf(
      XcodeSelectionUnsupportedError,
    );
    expect(cmd.probe).not.toHaveBeenCalled();
    expect(pinned.probe).not.toHaveBeenCalled();
  });

  it('passes other failures and successes through untouched', async () => {
    const cmd = new TestCommand([], {} as never);
    await expect(cmd.read(target, true, () => Promise.resolve('ok'))).resolves.toBe('ok');
    await expect(cmd.read(target, true, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cmd.probe).not.toHaveBeenCalled();
  });
});

describe('xcodeRefusal', () => {
  it('returns the daemon message for 400 and 409, nothing for other failures', () => {
    const cmd = new TestCommand([], {} as never);
    const notAvailable = 'Xcode 25 is not available on this sandbox; available: 26, 27';
    expect(cmd.refusal(daemonError(400, JSON.stringify({ message: notAvailable })))).toEqual({
      status: 400,
      message: notAvailable,
    });
    expect(cmd.refusal(daemonError(409, 'busy'))).toEqual({ status: 409, message: 'busy' });
    expect(cmd.refusal(daemonError(500, 'boom'))).toBeUndefined();
    expect(cmd.refusal(new Error('network'))).toBeUndefined();
  });
});
