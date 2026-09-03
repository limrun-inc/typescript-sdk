import { NotFoundError, XcodeSelectionUnsupportedError } from '@limrun/api';
import { BaseCommand } from './base-command';
import { clearLastInstanceId, LastXcodeInstance } from './lib/config';
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
    return {
      xcodeInstances: { get: this.probe },
      iosInstances: { get: jest.fn() },
    } as unknown as BaseCommand['client'];
  }

  markCreated(id: string): void {
    this._instancesCreatedThisRun.add(id);
  }

  read<T>(target: LastXcodeInstance, call: () => Promise<T>): Promise<T | undefined> {
    return this.readXcodeSelectionOrForget(target, call);
  }
}

const target: LastXcodeInstance = { id: 'xcode_eunb_gone', type: 'xcode' };
const unsupported = () => new XcodeSelectionUnsupportedError('GET /xcode');
const notFound = () => new NotFoundError(404, { message: 'not found' }, undefined, new Headers());

describe('readXcodeSelectionOrForget', () => {
  beforeEach(() => {
    clearLastInstanceIdMock.mockReset();
    stopDaemonMock.mockReset();
  });

  it('forgets a sandbox the API no longer knows instead of calling its daemon old', async () => {
    // The remembered sandbox was deleted (idle timeout, another machine). Its cached URL
    // yields a 404 that the SDK phrases as "daemon predates selection"; the API says gone.
    const cmd = new TestCommand([], {} as never);
    cmd.probe.mockRejectedValue(notFound());
    await expect(cmd.read(target, () => Promise.reject(unsupported()))).resolves.toBeUndefined();
    expect(cmd.probe).toHaveBeenCalledWith(target.id);
    expect(stopDaemonMock).toHaveBeenCalledWith(target.id);
    expect(clearLastInstanceIdMock).toHaveBeenCalledWith(target.id);
    expect(cmd.infoLines.join('\n')).toContain('no longer exists');
  });

  it('keeps the unsupported error when the sandbox is alive', async () => {
    const cmd = new TestCommand([], {} as never);
    cmd.probe.mockResolvedValue({ metadata: { id: target.id } });
    await expect(cmd.read(target, () => Promise.reject(unsupported()))).rejects.toBeInstanceOf(
      XcodeSelectionUnsupportedError,
    );
    expect(clearLastInstanceIdMock).not.toHaveBeenCalled();
  });

  it('does not probe a sandbox this run created', async () => {
    const cmd = new TestCommand([], {} as never);
    cmd.markCreated(target.id);
    await expect(cmd.read(target, () => Promise.reject(unsupported()))).rejects.toBeInstanceOf(
      XcodeSelectionUnsupportedError,
    );
    expect(cmd.probe).not.toHaveBeenCalled();
  });

  it('passes other failures and successes through untouched', async () => {
    const cmd = new TestCommand([], {} as never);
    await expect(cmd.read(target, () => Promise.resolve('ok'))).resolves.toBe('ok');
    await expect(cmd.read(target, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cmd.probe).not.toHaveBeenCalled();
  });
});
