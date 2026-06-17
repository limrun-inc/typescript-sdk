import fs from 'fs';
import os from 'os';
import path from 'path';
import type { XcodeClient } from '@limrun/api';
import { startBepWatcher } from '../packages/cli/src/lib/rbe-bep-watcher';

// Build a fully-flushed BEP for one build: started(uuid) -> namedSetOfFiles(.ipa)
// -> successful targetCompleted -> buildFinished -> lastMessage. `hash` controls
// the .ipa CAS digest so we can simulate edit/revert rebuilds.
function completedBep(opts: { invocation: string; hash: string; label?: string; success?: boolean }): string {
  const label = opts.label ?? '//App:App';
  const uri = `bytestream://127.0.0.1:8980/blobs/${opts.hash}/1024`;
  return [
    { started: { uuid: opts.invocation } },
    { id: { namedSet: { id: '0' } }, namedSetOfFiles: { files: [{ name: 'App/App.ipa', uri }] } },
    {
      id: { targetCompleted: { label } },
      completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: '0' }] }] },
    },
    { id: { buildFinished: {} }, finished: { overallSuccess: opts.success ?? true } },
    { id: { buildMetrics: {} }, lastMessage: true },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function fakeClient(calls: string[], result?: { installed?: boolean }): XcodeClient {
  return {
    installRbeBuildFromBep: async (opts: { bep: string; target: string }) => {
      // Parse the hash out of the bep the watcher passed, to assert it forwards
      // the right build.
      const m = opts.bep.match(/\/blobs\/([0-9a-f]+)\//);
      calls.push(m?.[1] ?? '');
      return {
        installed: result?.installed ?? true,
        ipaName: 'App/App.ipa',
      };
    },
  } as unknown as XcodeClient;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setupWorkspace(): { root: string; bepPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbe-watcher-'));
  const dir = path.join(root, '.limrun');
  fs.mkdirSync(dir, { recursive: true });
  return { root, bepPath: path.join(dir, 'bep.json') };
}

const fast = { debounceMs: 20, pollIntervalMs: 30 };

describe('startBepWatcher', () => {
  test('installs a completed build, dedupes the same invocation, re-installs a reverted digest', async () => {
    const { root, bepPath } = setupWorkspace();
    const calls: string[] = [];
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => fakeClient(calls),
      log: () => {},
      ...fast,
    });
    try {
      // Build A -> one install carrying digest A.
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      await waitFor(() => calls.length === 1);
      expect(calls[0]).toBe(HASH_A);

      // Re-touch the same invocation: no new install (dedup on invocation id).
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      await new Promise((r) => setTimeout(r, 150));
      expect(calls.length).toBe(1);

      // Edit -> build B (new invocation, new digest).
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-2', hash: HASH_B }));
      await waitFor(() => calls.length === 2);
      expect(calls[1]).toBe(HASH_B);

      // git stash + rebuild: new invocation, digest reverts to A. The watcher acts
      // because the invocation id is new, even though the digest equals an earlier one.
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-3', hash: HASH_A }));
      await waitFor(() => calls.length === 3);
      expect(calls[2]).toBe(HASH_A);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('watches a custom bep path outside .limrun', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbe-watcher-'));
    const customDir = path.join(root, 'out', 'events');
    fs.mkdirSync(customDir, { recursive: true });
    const bepPath = path.join(customDir, 'build_events.json'); // non-default dir AND filename
    const calls: string[] = [];
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => fakeClient(calls),
      log: () => {},
      ...fast,
    });
    try {
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      await waitFor(() => calls.length === 1);
      expect(calls[0]).toBe(HASH_A);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not install a failed build', async () => {
    const { root, bepPath } = setupWorkspace();
    const calls: string[] = [];
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => fakeClient(calls),
      log: () => {},
      ...fast,
    });
    try {
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A, success: false }));
      await new Promise((r) => setTimeout(r, 200));
      expect(calls.length).toBe(0);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('retries a transient install failure and eventually installs the same build', async () => {
    const { root, bepPath } = setupWorkspace();
    let attempt = 0;
    const calls: string[] = [];
    const client = {
      installRbeBuildFromBep: async (opts: { bep: string; target: string }) => {
        attempt++;
        if (attempt < 3) throw new Error('POST /rbe/install failed: 503 instance warming up');
        const m = opts.bep.match(/\/blobs\/([0-9a-f]+)\//);
        calls.push(m?.[1] ?? '');
        return { installed: true, ipaName: 'App/App.ipa' };
      },
    } as unknown as XcodeClient;
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => client,
      log: () => {},
      debounceMs: 20,
      pollIntervalMs: 5000, // keep the poll out of the way; retries drive this
      retryDelayMs: 30,
      maxRetries: 5,
    });
    try {
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      // No new build is written; the same build must be retried until it installs.
      await waitFor(() => calls.length === 1);
      expect(calls[0]).toBe(HASH_A);
      expect(attempt).toBeGreaterThanOrEqual(3);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('gives up after maxRetries transient failures (bounded, no infinite retry)', async () => {
    const { root, bepPath } = setupWorkspace();
    let attempt = 0;
    const calls: string[] = [];
    const logs: string[] = [];
    const client = {
      installRbeBuildFromBep: async () => {
        attempt++;
        throw new Error('POST /rbe/install failed: 503 still down');
      },
    } as unknown as XcodeClient;
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => client,
      log: (m) => logs.push(m),
      debounceMs: 20,
      pollIntervalMs: 5000,
      retryDelayMs: 20,
      maxRetries: 2,
    });
    try {
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      await waitFor(() => logs.some((l) => /gave up/.test(l)));
      const settled = attempt; // initial + maxRetries
      await new Promise((r) => setTimeout(r, 120));
      expect(attempt).toBe(settled); // bounded — no further retries after giving up
      expect(calls.length).toBe(0);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('gates on lastMessage: a parseable-but-not-flushed BEP does not install until terminal', async () => {
    const { root, bepPath } = setupWorkspace();
    const calls: string[] = [];
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => fakeClient(calls),
      log: () => {},
      ...fast,
    });
    try {
      // A complete build minus the terminal lastMessage line (digest already parseable).
      const full = completedBep({ invocation: 'inv-1', hash: HASH_A });
      const withoutLast = full.split('\n').slice(0, -1).join('\n');
      fs.writeFileSync(bepPath, withoutLast);
      await new Promise((r) => setTimeout(r, 200));
      expect(calls.length).toBe(0); // not flushed -> must not act
      fs.writeFileSync(bepPath, full); // lastMessage arrives
      await waitFor(() => calls.length === 1);
      expect(calls[0]).toBe(HASH_A);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not latch auth off on a 5xx whose body merely contains 401', async () => {
    const { root, bepPath } = setupWorkspace();
    let attempt = 0;
    const calls: string[] = [];
    // First install throws a 502 whose body text contains "401"; it must be treated
    // as transient (not an auth latch), so a later build still installs.
    const client = {
      installRbeBuildFromBep: async (opts: { bep: string; target: string }) => {
        attempt++;
        if (attempt === 1) throw new Error('POST /rbe/install failed: 502 upstream {"traceId":"7f-401-bad"}');
        const m = opts.bep.match(/\/blobs\/([0-9a-f]+)\//);
        calls.push(m?.[1] ?? '');
        return { installed: true, ipaName: 'App/App.ipa' };
      },
    } as unknown as XcodeClient;
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => client,
      log: () => {},
      ...fast,
    });
    try {
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      await new Promise((r) => setTimeout(r, 200)); // first attempt throws the 502-with-401
      // A later build must still install — proving the 502 did NOT latch auth off.
      // (We assert on the new digest rather than call count: a transient failure
      // isn't marked handled, so inv-1 may be retried by a second trigger.)
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-2', hash: HASH_B }));
      await waitFor(() => calls.includes(HASH_B));
      expect(attempt).toBeGreaterThanOrEqual(2);
    } finally {
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('close() awaits an in-flight install and does not double-fire a queued build', async () => {
    const { root, bepPath } = setupWorkspace();
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client = {
      installRbeBuildFromBep: async (opts: { bep: string; target: string }) => {
        const m = opts.bep.match(/\/blobs\/([0-9a-f]+)\//);
        calls.push(m?.[1] ?? '');
        await gate; // block the first install in-flight
        return { installed: true, ipaName: 'App/App.ipa' };
      },
    } as unknown as XcodeClient;
    const watcher = startBepWatcher({
      bepPath,
      target: '//App:App',
      getClient: () => client,
      log: () => {},
      ...fast,
    });
    try {
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-1', hash: HASH_A }));
      await waitFor(() => calls.length === 1); // install A is now in-flight, blocked on the gate
      fs.writeFileSync(bepPath, completedBep({ invocation: 'inv-2', hash: HASH_B })); // queue B while closing
      let closed = false;
      const closing = watcher.close().then(() => (closed = true));
      await new Promise((r) => setTimeout(r, 100));
      expect(closed).toBe(false); // close() must await the in-flight install
      release();
      await closing;
      expect(closed).toBe(true);
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toEqual([HASH_A]); // B must NOT fire after close()
    } finally {
      release();
      await watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
