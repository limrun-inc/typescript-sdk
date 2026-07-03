import { startAutoUploadWatcher } from '../packages/cli/src/lib/rbe-auto-upload';
import type { RbeBuildSummary, RbeUploadResult, XcodeClient } from '@limrun/api';

/** Yield until pending microtasks and short timers have run. */
const settle = async (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Mock arg tuples must match the real signatures exactly (property-typed
// functions are contravariant in their parameters under strictFunctionTypes).
type FakeClient = {
  getRecentRbeBuilds: jest.Mock<
    ReturnType<XcodeClient['getRecentRbeBuilds']>,
    Parameters<XcodeClient['getRecentRbeBuilds']>
  >;
  uploadLatestRbeBuild: jest.Mock<
    ReturnType<XcodeClient['uploadLatestRbeBuild']>,
    Parameters<XcodeClient['uploadLatestRbeBuild']>
  >;
};

/** Builds a recent-view payload carrying the wire's undeclared startedAt with
 *  literal excess-property checking intact (an `as` cast would silence typos). */
type WireBuild = { invocationId: string; status: string; startedAt?: string };
function wireBuilds(builds: WireBuild[]): RbeBuildSummary[] {
  return builds as RbeBuildSummary[];
}

function fakeClient(): FakeClient {
  return {
    getRecentRbeBuilds: jest.fn(async (): Promise<RbeBuildSummary[]> => []),
    uploadLatestRbeBuild: jest.fn(async (_opts): Promise<RbeUploadResult> => ({ appName: 'MyApp.app' })),
  };
}

describe('startAutoUploadWatcher', () => {
  test('uploads once when a build turns terminal SUCCEEDED', async () => {
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockResolvedValueOnce([{ invocationId: 'inv-1', status: 'RUNNING' }]) // baseline
      .mockResolvedValue([{ invocationId: 'inv-1', status: 'SUCCEEDED' }]);
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', ttl: '24h', log, pollMs: 5 });
    await settle();
    await watcher.stop();
    // One upload despite many polls listing the same terminal entry.
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledWith({ assetName: 'preview/app', ttl: '24h' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('uploaded MyApp.app'));
  });

  test('skips the upload for a failed build', async () => {
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockResolvedValueOnce([]) // baseline
      .mockResolvedValue([{ invocationId: 'inv-2', status: 'FAILED' }]);
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 5 });
    await settle();
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FAILED; skipping upload'));
  });

  test('builds already terminal at arming are baseline, not uploaded', async () => {
    const client = fakeClient();
    client.getRecentRbeBuilds.mockResolvedValue([{ invocationId: 'inv-old', status: 'SUCCEEDED' }]);
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log: jest.fn(), pollMs: 5 });
    await settle();
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).not.toHaveBeenCalled();
  });

  test('a post-arm build finishing during an initial poll-failure streak is still uploaded', async () => {
    // The baseline poll only lands AFTER a failure streak; the build started
    // after arming (startedAt in the future relative to armedAt) and finished
    // inside the streak, so it is terminal at the baseline. startedAt must
    // rescue it from being misclassified as pre-arm.
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockRejectedValueOnce(new Error('router blip'))
      .mockRejectedValueOnce(new Error('router blip'))
      .mockResolvedValue(
        wireBuilds([
          {
            invocationId: 'inv-streak',
            status: 'SUCCEEDED',
            startedAt: new Date(Date.now() + 1000).toISOString(),
          },
          // A genuinely pre-arm terminal entry stays baselined out.
          {
            invocationId: 'inv-old',
            status: 'SUCCEEDED',
            startedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ]),
      );
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log: jest.fn(), pollMs: 1 });
    await settle(50);
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
  });

  test('an unknown non-terminal status is not marked handled, so its terminal state still acts', async () => {
    // Forward compat: a future daemon adds an in-flight status this CLI
    // predates; it must behave like RUNNING, not poison the invocation.
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockResolvedValueOnce([]) // baseline
      .mockResolvedValueOnce([{ invocationId: 'inv-q', status: 'QUEUED' }])
      .mockResolvedValue([{ invocationId: 'inv-q', status: 'SUCCEEDED' }]);
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log: jest.fn(), pollMs: 5 });
    await settle(60);
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
  });

  test('a build finishing entirely between polls (or during an outage) is still uploaded', async () => {
    // Never seen RUNNING: appears directly as terminal after the baseline.
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockResolvedValueOnce([]) // baseline
      .mockRejectedValueOnce(new Error('router blip')) // outage
      .mockResolvedValue([{ invocationId: 'inv-fast', status: 'SUCCEEDED' }]);
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 5 });
    await settle(60);
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('polling failed'));
  });

  test('stop() halts polling and suppresses queued uploads', async () => {
    const client = fakeClient();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log: jest.fn(), pollMs: 5 });
    await settle(15);
    await watcher.stop();
    const pollsAtStop = client.getRecentRbeBuilds.mock.calls.length;
    expect(pollsAtStop).toBeGreaterThan(0);
    await settle(25);
    expect(client.getRecentRbeBuilds.mock.calls.length).toBe(pollsAtStop);
  });

  test('a failed upload is re-attempted on a later poll, bounded per build', async () => {
    // The SDK retries transient errors internally; a longer outage must not
    // permanently drop a successful build's upload, and a permanent failure
    // must not retry forever.
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockResolvedValueOnce([]) // baseline
      .mockResolvedValue([{ invocationId: 'inv-r', status: 'SUCCEEDED' }]);
    client.uploadLatestRbeBuild
      .mockRejectedValueOnce(new Error('asset storage down'))
      .mockResolvedValue({ appName: 'MyApp.app' });
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 5 });
    await settle(60);
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('upload failed (attempt 1/3)'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('uploaded MyApp.app'));
  });

  test('a permanently failing upload stops after the attempt cap', async () => {
    const client = fakeClient();
    client.getRecentRbeBuilds
      .mockResolvedValueOnce([]) // baseline
      .mockResolvedValue([{ invocationId: 'inv-p', status: 'SUCCEEDED' }]);
    client.uploadLatestRbeBuild.mockRejectedValue(new Error('invalid ttl'));
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 5 });
    await settle(80);
    await watcher.stop();
    expect(client.uploadLatestRbeBuild).toHaveBeenCalledTimes(3);
  });

  test('a poll failure is logged once per streak and polling survives', async () => {
    const client = fakeClient();
    client.getRecentRbeBuilds.mockRejectedValue(new Error('daemon restarting'));
    const log = jest.fn();
    const watcher = startAutoUploadWatcher({ client, assetName: 'preview/app', log, pollMs: 1 });
    await settle(40);
    await watcher.stop();
    expect(client.getRecentRbeBuilds.mock.calls.length).toBeGreaterThan(1);
    expect(log.mock.calls.filter(([m]) => String(m).includes('polling failed'))).toHaveLength(1);
  });
});
