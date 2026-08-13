import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildTunnelServeArgs,
  capTunnelLog,
  claimTunnelProcess,
  clearTunnelProcess,
  formatTunnelRoute,
  isTunnelOwnerProcessAlive,
  listTunnelProcesses,
  loadTunnelProcess,
  newTunnelOwner,
  parseTunnelRoute,
  prepareTunnelLog,
  pruneTunnelLogs,
  readTunnelLogTail,
  selectTunnelOwnersForStop,
  signalTunnelOwner,
  stopTunnelErrorIsNotFound,
  tunnelChildEnvironment,
  tunnelProcessPaths,
  tunnelProcessStartingLeaseExpired,
  updateTunnelProcess,
  waitForTunnelProcessReady,
  type IosTunnelProcessState,
} from './ios-tunnel-process';

const INSTANCE_ID = 'ios_test_123';
const OWNER_1 = '1'.repeat(32);
const OWNER_2 = '2'.repeat(32);
const OWNER_3 = '3'.repeat(32);

describe('iOS tunnel process state', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-ios-tunnel-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['localhost:8000', { host: 'localhost', port: 8000 }],
    ['API.Example.COM:443', { host: 'API.Example.COM', port: 443 }],
    ['[2001:db8::1]:8443', { host: '2001:db8::1', port: 8443 }],
  ])('parses route %s', (input, expected) => {
    expect(parseTunnelRoute(input)).toEqual(expected);
  });

  test.each(['localhost', ':8000', 'localhost:0', 'localhost:65536', '2001:db8::1:443'])(
    'rejects malformed route %s',
    (input) => {
      expect(() => parseTunnelRoute(input)).toThrow();
    },
  );

  test('builds a child command with an exact owner and IPv6 route', () => {
    const owner = newTunnelOwner();
    expect(owner).toMatch(/^[0-9a-f]{32}$/);
    expect(
      buildTunnelServeArgs({
        scriptPath: '/lim/run.js',
        instanceId: INSTANCE_ID,
        owner,
        routes: [
          { host: 'localhost', port: 8000 },
          { host: '2001:db8::1', port: 8443 },
        ],
      }),
    ).toEqual([
      '/lim/run.js',
      'ios',
      'tunnel',
      '--serve',
      '--no-create',
      '--id',
      INSTANCE_ID,
      `--tunnel-owner=${owner}`,
      '--route',
      'localhost:8000',
      '--route',
      '[2001:db8::1]:8443',
    ]);
    expect(formatTunnelRoute({ host: '2001:db8::1', port: 443 })).toBe('[2001:db8::1]:443');
  });

  test('forwards an explicit API key only through the child environment', () => {
    expect(tunnelChildEnvironment('secret', { PATH: '/bin', LIM_API_KEY: 'old' })).toEqual({
      PATH: '/bin',
      LIM_API_KEY: 'secret',
    });
    expect(tunnelChildEnvironment(undefined, { PATH: '/bin' })).toEqual({
      PATH: '/bin',
    });
  });

  test('accepts READY written exactly at the parent deadline', async () => {
    let now = 0;
    let reads = 0;
    const ready = makeReadyState();
    await expect(
      waitForTunnelProcessReady({
        load: () => {
          reads += 1;
          if (reads === 1) return makeState({ pid: 123 });
          return ready;
        },
        isAlive: () => true,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        now: () => now,
        timeoutMs: 100,
        pollMs: 100,
      }),
    ).resolves.toEqual({ outcome: 'ready', state: ready });
  });

  test('reports a child exit before READY', async () => {
    await expect(
      waitForTunnelProcessReady({
        load: () => undefined,
        isAlive: () => false,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ outcome: 'exited' });
  });

  test('does not accept stale READY from an exited child', async () => {
    const ready = makeReadyState();
    await expect(
      waitForTunnelProcessReady({
        load: () => ready,
        isAlive: () => false,
        sleep: async () => {},
      }),
    ).resolves.toEqual({ outcome: 'exited' });
  });

  test('selects only owners correlated with the fetched server tunnel ID', () => {
    const oldOwner = makeReadyState({
      owner: OWNER_1,
      tunnelId: 'old-tunnel',
    });
    const replacement = makeReadyState({
      owner: OWNER_2,
      tunnelId: 'replacement',
    });
    const starting = makeState({ owner: OWNER_3, pid: 456 });
    expect(selectTunnelOwnersForStop([oldOwner, replacement, starting], 'old-tunnel')).toEqual([
      oldOwner,
      starting,
    ]);
    expect(selectTunnelOwnersForStop([oldOwner, replacement, starting], undefined)).toEqual([
      oldOwner,
      replacement,
      starting,
    ]);
  });

  test('classifies only the stable stop 404 error as already gone', () => {
    expect(stopTunnelErrorIsNotFound(new Error('stopTunnel failed: 404 missing'))).toBe(true);
    expect(stopTunnelErrorIsNotFound(new Error('stopTunnel failed: 500 broken'))).toBe(false);
  });

  test('keeps each owner state isolated through update and clear', () => {
    const state = makeState({ owner: OWNER_1, pid: process.pid, status: 'starting' });
    expect(claimTunnelProcess(state, root)).toBe(true);
    expect(claimTunnelProcess(makeState({ owner: OWNER_2 }), root)).toBe(true);
    expect(listTunnelProcesses(INSTANCE_ID, root)).toHaveLength(2);

    const ready = makeState({
      owner: OWNER_1,
      pid: process.pid,
      status: 'ready',
      tunnelId: 'tunnel-1',
      bindings: [
        {
          routeId: 'route-1',
          route: { host: 'localhost', port: 8000 },
          endpoint: { host: '10.0.0.8', port: 57090 },
        },
      ],
    });
    updateTunnelProcess(ready, OWNER_1, root);
    expect(loadTunnelProcess(INSTANCE_ID, OWNER_1, root)).toEqual(ready);
    expect(() => updateTunnelProcess(ready, OWNER_2, root)).toThrow(
      'Tunnel process ownership changed during startup',
    );

    expect(clearTunnelProcess(INSTANCE_ID, OWNER_2, root)).toBe(true);
    expect(loadTunnelProcess(INSTANCE_ID, OWNER_1, root)).toEqual(ready);
    expect(clearTunnelProcess(INSTANCE_ID, OWNER_1, root)).toBe(true);
    expect(listTunnelProcesses(INSTANCE_ID, root)).toEqual([]);
  });

  test('keeps expired ownership visible for process cleanup', () => {
    const abandoned = makeState({
      owner: OWNER_1,
      pid: process.pid,
      status: 'starting',
      startedAt: new Date(Date.now() - 31_000).toISOString(),
    });
    expect(claimTunnelProcess(abandoned, root)).toBe(true);
    expect(loadTunnelProcess(abandoned.instanceId, OWNER_1, root)).toEqual(abandoned);
    expect(tunnelProcessStartingLeaseExpired(abandoned)).toBe(true);

    const replacement = makeState({ owner: OWNER_2, pid: 0, status: 'starting' });
    expect(claimTunnelProcess(replacement, root)).toBe(true);
    expect(
      listTunnelProcesses(INSTANCE_ID, root)
        .map((state) => state.owner)
        .sort(),
    ).toEqual([OWNER_1, OWNER_2]);
  });

  test('does not overwrite the same owner claim', () => {
    expect(claimTunnelProcess(makeState({ owner: OWNER_1, pid: 0 }), root)).toBe(true);
    expect(claimTunnelProcess(makeState({ owner: OWNER_1, pid: 0 }), root)).toBe(false);
  });

  test('cannot update or reclaim an owner after cleanup starts', () => {
    const starting = makeState({ owner: OWNER_1, pid: 0 });
    expect(claimTunnelProcess(starting, root)).toBe(true);
    expect(clearTunnelProcess(INSTANCE_ID, OWNER_1, root)).toBe(true);
    expect(clearTunnelProcess(INSTANCE_ID, OWNER_1, root)).toBe(true);
    expect(() => updateTunnelProcess(makeReadyState({ owner: OWNER_1, pid: 123 }), OWNER_1, root)).toThrow(
      'Tunnel process ownership changed during startup',
    );
    expect(claimTunnelProcess(starting, root)).toBe(false);
    expect(loadTunnelProcess(INSTANCE_ID, OWNER_1, root)).toBeUndefined();
  });

  test('verifies process identity before treating a PID as the owner', async () => {
    const owner = crypto.randomBytes(16).toString('hex');
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--', `--tunnel-owner=${owner}`],
      { stdio: 'ignore' },
    );
    const pid = child.pid;
    if (!pid) throw new Error('child process did not start');
    const state = makeState({ owner, pid, status: 'starting' });
    try {
      expect(claimTunnelProcess(state, root)).toBe(true);
      await waitFor(() => isTunnelOwnerProcessAlive(state));
      expect(isTunnelOwnerProcessAlive({ ...state, owner: OWNER_1 })).toBe(false);
      expect(clearTunnelProcess(state.instanceId, owner, root)).toBe(false);
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(signalTunnelOwner(state, 'SIGKILL')).toBe('signaled');
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
      }
    }
    expect(clearTunnelProcess(state.instanceId, owner, root)).toBe(true);
  });

  test.each([
    { startedAt: new Date(Date.now() + 120_000).toISOString() },
    { startedAt: 123 as unknown as string },
    { startedAt: new Date().toUTCString() },
    { logPath: '/tmp/attacker.log' },
    { tunnelId: 'premature' },
    { bindings: [] },
    { status: 'ready', pid: 0, tunnelId: 'tunnel-1', bindings: [] },
    { routes: [{ host: '*.example.com', port: 443 }] },
  ] satisfies Array<Partial<IosTunnelProcessState>>)('rejects malformed persisted state %#', (overrides) => {
    const state = makeState(overrides);
    const paths = tunnelProcessPaths(state.instanceId, state.owner, root);
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.state, JSON.stringify(state));
    expect(loadTunnelProcess(state.instanceId, state.owner, root)).toBeUndefined();
  });

  test('uses a bounded hashed path and reads the log tail', () => {
    const paths = tunnelProcessPaths('ios_region_secret-customer-id', OWNER_1, root);
    expect(paths.directory).not.toContain('secret-customer-id');
    expect(paths.directory.length).toBeLessThan(root.length + 20);
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.log, `${'x'.repeat(128 * 1024)}\none\ntwo\nthree\n`);
    expect(readTunnelLogTail(paths.log, 2, 64 * 1024)).toBe('two\nthree');
  });

  test('rotates an oversized retained log', () => {
    const paths = tunnelProcessPaths(INSTANCE_ID, OWNER_1, root);
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.log, 'old log');
    fs.closeSync(prepareTunnelLog(paths.log, 1));
    expect(fs.readFileSync(`${paths.log}.1`, 'utf8')).toBe('g');
    expect(fs.readFileSync(paths.log, 'utf8')).toBe('');
  });

  test('caps a log while its append descriptor remains open', () => {
    const paths = tunnelProcessPaths(INSTANCE_ID, OWNER_1, root);
    const descriptor = prepareTunnelLog(paths.log, 1024);
    fs.writeSync(descriptor, 'old log');
    expect(capTunnelLog(paths.log, 4)).toBe(true);
    fs.writeSync(descriptor, 'new');
    fs.closeSync(descriptor);

    expect(fs.readFileSync(`${paths.log}.1`, 'utf8')).toBe(' log');
    expect(fs.readFileSync(paths.log, 'utf8')).toBe('new');
  });

  test('retains only the newest completed tunnel logs', () => {
    for (let index = 1; index <= 7; index++) {
      const owner = index.toString(16).padStart(32, '0');
      const paths = tunnelProcessPaths(INSTANCE_ID, owner, root);
      fs.mkdirSync(paths.directory, { recursive: true });
      fs.writeFileSync(paths.log, owner);
      const modified = new Date(Date.now() + index * 1000);
      fs.utimesSync(paths.log, modified, modified);
    }

    pruneTunnelLogs(INSTANCE_ID, root, 2);
    const directory = tunnelProcessPaths(INSTANCE_ID, OWNER_1, root).directory;
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith('.log'))).toHaveLength(2);
  });

  function makeReadyState(overrides: Partial<IosTunnelProcessState> = {}): IosTunnelProcessState {
    return makeState({
      pid: 123,
      status: 'ready',
      tunnelId: 'tunnel-1',
      bindings: [
        {
          routeId: 'route-1',
          route: { host: 'localhost', port: 8000 },
          endpoint: { host: '10.0.0.8', port: 57090 },
        },
      ],
      ...overrides,
    });
  }

  function makeState(overrides: Partial<IosTunnelProcessState>): IosTunnelProcessState {
    const owner = overrides.owner ?? OWNER_1;
    return {
      owner,
      pid: 0,
      instanceId: INSTANCE_ID,
      status: 'starting',
      routes: [{ host: 'localhost', port: 8000 }],
      startedAt: new Date().toISOString(),
      logPath: tunnelProcessPaths(INSTANCE_ID, owner, root).log,
      ...overrides,
    };
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('waitFor timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
