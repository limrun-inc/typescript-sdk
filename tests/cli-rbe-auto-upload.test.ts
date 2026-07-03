import { startAutoUploadWatcher } from '../packages/cli/src/lib/rbe-auto-upload';
import type { RbeActiveBuild, RbeUploadResult, XcodeClient } from '@limrun/api';

/** Yield until pending microtasks and timers scheduled at 0-1ms have run. */
const settle = async (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Mock arg tuples must match the real signatures exactly (property-typed
// functions are contravariant in their parameters under strictFunctionTypes).
type FakeClient = {
  getActiveRbeBuilds: jest.Mock<
    ReturnType<XcodeClient['getActiveRbeBuilds']>,
    Parameters<XcodeClient['getActiveRbeBuilds']>
  >;
  waitForRbeBuildEnd: jest.Mock<
    ReturnType<XcodeClient['waitForRbeBuildEnd']>,
    Parameters<XcodeClient['waitForRbeBuildEnd']>
  >;
  uploadLatestRbeBuild: jest.Mock<
    ReturnType<XcodeClient['uploadLatestRbeBuild']>,
    Parameters<XcodeClient['uploadLatestRbeBuild']>
  >;
};

function fakeClient(): FakeClient {
  return {
    getActiveRbeBuilds: jest.fn(async (): Promise<RbeActiveBuild[]> => []),
    waitForRbeBuildEnd: jest.fn(),
    uploadLatestRbeBuild: jest.fn(async (_opts): Promise<RbeUploadResult> => ({ appName: 'MyApp.app' })),
  };
}

describe('startAutoUploadWatcher', () => {
  test('uploads once per successful build', async () => {
    const client = fakeClient();
    client.getActiveRbeBuilds.mockResolvedValue([{ invocationId: 'inv-1', status: 'RUNNING' }]);
    client.waitForRbeBuildEnd.mockResolvedValue({ invocationId: 'inv-1', status: 'SUCCEEDED' });
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', ttl: '24h', log, pollMs: 5 });
    await settle();
    watcher.stop();
    // One upload despite many polls: the invocation is registered once.
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledWith({ assetName: 'preview/app', ttl: '24h' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('uploaded MyApp.app'));
  });

  test('skips the upload for a failed build', async () => {
    const client = fakeClient();
    client.getActiveRbeBuilds.mockResolvedValue([{ invocationId: 'inv-2', status: 'RUNNING' }]);
    client.waitForRbeBuildEnd.mockResolvedValue({ invocationId: 'inv-2', status: 'FAILED' });
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 5 });
    await settle();
    watcher.stop();
    expect(client.uploadLatestRbeBuild).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FAILED; skipping upload'));
  });

  test('falls back to uploading when the stream drops and the build is gone', async () => {
    const client = fakeClient();
    client.getActiveRbeBuilds
      .mockResolvedValueOnce([{ invocationId: 'inv-3', status: 'RUNNING' }])
      .mockResolvedValue([]); // gone from the active list from then on
    client.waitForRbeBuildEnd.mockRejectedValue(new Error('stream ended without a terminal event'));
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 5 });
    await settle();
    watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unknown status'));
  });

  test('re-subscribes when the stream drops but the build is still active', async () => {
    const client = fakeClient();
    client.getActiveRbeBuilds.mockResolvedValue([{ invocationId: 'inv-4', status: 'RUNNING' }]);
    client.waitForRbeBuildEnd
      .mockRejectedValueOnce(new Error('stream blip'))
      .mockResolvedValue({ invocationId: 'inv-4', status: 'SUCCEEDED' });
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log: jest.fn(), pollMs: 5 });
    await settle();
    watcher.stop();
    expect(client.waitForRbeBuildEnd).toHaveBeenCalledTimes(2);
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
  });

  test('aborts a silently hung wait once the build leaves the active list, then uploads via fallback', async () => {
    // Regression: a half-open SSE kept waitForRbeBuildEnd pending forever
    // while the build had finished, silently dropping the upload. The
    // liveness guard must abort the wait and let the fallback fire.
    const client = fakeClient();
    client.getActiveRbeBuilds
      .mockResolvedValueOnce([{ invocationId: 'inv-5', status: 'RUNNING' }])
      .mockResolvedValue([]); // gone from then on, while the wait hangs
    client.waitForRbeBuildEnd.mockImplementation(
      (_id, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({
      client,
      assetName: 'preview/app',
      log,
      pollMs: 5,
      goneGraceMs: 10,
    });
    await settle(60);
    watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unknown status'));
  });

  test('stop() halts polling and suppresses further uploads', async () => {
    const client = fakeClient();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log: jest.fn(), pollMs: 5 });
    await settle(15);
    watcher.stop();
    const pollsAtStop = client.getActiveRbeBuilds.mock.calls.length;
    expect(pollsAtStop).toBeGreaterThan(0);
    await settle(25);
    expect(client.getActiveRbeBuilds.mock.calls.length).toBe(pollsAtStop);
  });

  test('a poll failure is logged once per streak and polling survives', async () => {
    const client = fakeClient();
    client.getActiveRbeBuilds.mockRejectedValue(new Error('daemon restarting'));
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 1 });
    await settle(40);
    void watcher.stop();
    expect(client.getActiveRbeBuilds.mock.calls.length).toBeGreaterThan(1);
    expect(log.mock.calls.filter(([m]) => String(m).includes('polling failed'))).toHaveLength(1);
  });

  test('recovering from a multi-poll outage fires a catch-up upload', async () => {
    // A short build can start and finish inside a backoff gap; the catch-up
    // upload after recovery covers it. A single blip must not trigger one.
    const client = fakeClient();
    client.getActiveRbeBuilds
      .mockRejectedValueOnce(new Error('router blip'))
      .mockRejectedValueOnce(new Error('router blip'))
      .mockResolvedValue([]);
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 1 });
    await settle(50);
    void watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('catch up'));
  });
});
