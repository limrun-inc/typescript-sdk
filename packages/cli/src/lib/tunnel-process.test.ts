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
  formatTunnelDialFailure,
  formatTunnelSelectors,
  isSpawnedTunnelProcessAlive,
  isTunnelProcessCancelled,
  listTunnelProcesses,
  loadTunnelProcess,
  markTunnelProcessCancelled,
  newTunnelOwner,
  parseTunnelCidr,
  parseTunnelDomain,
  parseTunnelRoute,
  prepareTunnelLog,
  pruneTunnelLogs,
  readTunnelLogTail,
  selectTunnelOwnersForStop,
  signalTunnelOwner,
  stopTunnelErrorIsNotFound,
  subscribeTunnelDisconnect,
  tunnelChildEnvironment,
  tunnelOwnerProcessIdentity,
  tunnelProcessPaths,
  tunnelProcessStartingLeaseExpired,
  updateTunnelProcess,
  waitForTunnelProcessReady,
  type TunnelProcessState,
} from './tunnel-process';

const INSTANCE_ID = 'android_test_123';
const OWNER_1 = '1'.repeat(32);
const OWNER_2 = '2'.repeat(32);
const OWNER_3 = '3'.repeat(32);

describe('tunnel process state', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-tunnel-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['LOCALHOST:3000', { host: 'localhost', port: 3000 }],
    ['10.20.30.40:8000', { host: '10.20.30.40', port: 8000 }],
    ['[2001:db8::1]:8443', { host: '2001:db8::1', port: 8443 }],
    ['[::ffff:192.0.2.1]:9443', { host: '192.0.2.1', port: 9443 }],
  ])('parses route %s', (input, expected) => {
    expect(parseTunnelRoute(input)).toEqual(expected);
  });

  test.each([
    'localhost.:8000',
    ':8000',
    '10.20.30.40:0',
    '10.20.30.40:53',
    '10.20.30.40:65536',
    '2001:db8::1:443',
    '[::192.0.2.1]:443',
    '[::2]:443',
  ])('rejects malformed route %s', (input) => {
    expect(() => parseTunnelRoute(input)).toThrow();
  });

  test('applies the Android minimum route port', () => {
    expect(() => parseTunnelRoute('localhost:80', { minPort: 1024 })).toThrow('expected 1024-65535');
    expect(parseTunnelRoute('localhost:8080', { minPort: 1024 })).toEqual({ host: 'localhost', port: 8080 });
  });

  test.each([
    ['API.Corp.Example', 'api.corp.example'],
    ['*.Corp.Example', '*.corp.example'],
  ])('parses domain %s', (input, expected) => {
    expect(parseTunnelDomain(input)).toBe(expected);
  });

  test.each(['corp.example.', 'api.*.example', 'localhost', '192.0.2.1'])(
    'rejects malformed domain %s',
    (input) => {
      expect(() => parseTunnelDomain(input)).toThrow('Invalid domain');
    },
  );

  test('parses and rejects CIDRs', () => {
    expect(parseTunnelCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(() => parseTunnelCidr('10.0.0.1/8')).toThrow('Invalid CIDR');
    expect(() => parseTunnelCidr('198.19.0.0/24')).toThrow('Invalid CIDR');
  });

  test('builds a child command replaying every selector kind', () => {
    const owner = newTunnelOwner();
    expect(
      buildTunnelServeArgs({
        scriptPath: '/lim/run.js',
        product: 'android',
        instanceId: INSTANCE_ID,
        owner,
        selectors: {
          routes: [
            { host: '10.20.30.40', port: 8000 },
            { host: '2001:db8::1', port: 8443 },
          ],
          domains: ['*.corp.example'],
          cidrs: ['10.0.0.0/8'],
        },
      }),
    ).toEqual([
      '/lim/run.js',
      'android',
      'tunnel',
      '--serve',
      '--no-create',
      '--id',
      INSTANCE_ID,
      `--tunnel-owner=${owner}`,
      '--route',
      '10.20.30.40:8000',
      '--route',
      '[2001:db8::1]:8443',
      '--domain',
      '*.corp.example',
      '--cidr',
      '10.0.0.0/8',
    ]);
  });

  test('builds an iOS child command with routes only', () => {
    const owner = newTunnelOwner();
    expect(
      buildTunnelServeArgs({
        scriptPath: '/lim/run.js',
        product: 'ios',
        instanceId: 'ios_test_123',
        owner,
        selectors: { routes: [{ host: '10.20.30.40', port: 8000 }] },
      }),
    ).toEqual([
      '/lim/run.js',
      'ios',
      'tunnel',
      '--serve',
      '--no-create',
      '--id',
      'ios_test_123',
      `--tunnel-owner=${owner}`,
      '--route',
      '10.20.30.40:8000',
    ]);
  });

  test('formats dial failures with every correlation ID', () => {
    expect(
      formatTunnelDialFailure({
        tunnelId: 'tunnel-1',
        connectionId: 7,
        routeId: 'route-3',
        reason: 'dns_not_found',
        osCode: 'ENOTFOUND',
      }),
    ).toBe('Last dial failure: tunnel tunnel-1, connection 7, route-3 (dns_not_found, ENOTFOUND)');
  });

  test('formats every selector kind for display', () => {
    expect(
      formatTunnelSelectors({
        routes: [{ host: 'localhost', port: 8080 }],
        domains: ['*.corp.example'],
        cidrs: ['10.0.0.0/8'],
      }),
    ).toEqual(['route localhost:8080', 'domain *.corp.example', 'cidr 10.0.0.0/8']);
  });

  test('forwards an explicit API key only through the child environment', () => {
    expect(tunnelChildEnvironment('secret', { PATH: '/bin', LIM_API_KEY: 'old' })).toEqual({
      PATH: '/bin',
      LIM_API_KEY: 'secret',
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

  test('does not mistake a reused PID for the spawned child', () => {
    expect(isSpawnedTunnelProcessAlive({ exitCode: 0, signalCode: null }, process.pid)).toBe(false);
    expect(isSpawnedTunnelProcessAlive({ exitCode: null, signalCode: null }, process.pid)).toBe(true);
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

  test('observes a disconnect that happened before subscription', () => {
    const unsubscribe = jest.fn();
    const onDisconnect = jest.fn();
    const dispose = subscribeTunnelDisconnect(
      {
        getConnectionState: () => 'disconnected',
        onConnectionStateChange: () => unsubscribe,
      },
      onDisconnect,
    );

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    dispose();
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

  test('a cancelled starting owner cannot become ready again', () => {
    const starting = makeState({ owner: OWNER_1, pid: process.pid, status: 'starting' });
    expect(claimTunnelProcess(starting, root)).toBe(true);
    expect(isTunnelProcessCancelled(INSTANCE_ID, OWNER_1, root)).toBe(false);

    // A stop marks cancellation first, before signaling the child.
    markTunnelProcessCancelled(INSTANCE_ID, OWNER_1, root);
    expect(isTunnelProcessCancelled(INSTANCE_ID, OWNER_1, root)).toBe(true);

    // The child's ready transition (or reconnect replay) now fails closed.
    expect(() =>
      updateTunnelProcess(
        makeState({ owner: OWNER_1, pid: process.pid, status: 'ready', tunnelId: 'tunnel-race' }),
        OWNER_1,
        root,
      ),
    ).toThrow('Tunnel process ownership changed during startup');
    expect(claimTunnelProcess(starting, root)).toBe(false);
  });

  test('keeps expired ownership visible for process cleanup', () => {
    const now = Date.now();
    const abandoned = makeState({
      owner: OWNER_1,
      pid: process.pid,
      status: 'starting',
      startedAt: new Date(now - 30_000).toISOString(),
    });
    expect(claimTunnelProcess(abandoned, root)).toBe(true);
    expect(loadTunnelProcess(abandoned.instanceId, OWNER_1, root)).toEqual(abandoned);
    expect(tunnelProcessStartingLeaseExpired(abandoned, now)).toBe(true);
    expect(
      tunnelProcessStartingLeaseExpired(
        { ...abandoned, startedAt: new Date(now - 29_999).toISOString() },
        now,
      ),
    ).toBe(false);

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
      await waitFor(() => tunnelOwnerProcessIdentity(state) === 'match');
      expect(tunnelOwnerProcessIdentity({ ...state, owner: OWNER_1 })).toBe('mismatch');
      expect(signalTunnelOwner({ ...state, owner: OWNER_1 }, 'SIGTERM')).toBe('mismatch');
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
    { status: 'ready', pid: 0 },
    { product: 'linux' as unknown as TunnelProcessState['product'] },
    { selectors: { routes: [{ host: '*.example.com', port: 443 }] } },
    { selectors: { routes: [{ host: 'LOCALHOST', port: 3000 }] } },
    { selectors: { routes: [{ host: '10.20.30.40', port: 53 }] } },
    { selectors: { routes: [{ host: '::2', port: 443 }] } },
    {
      selectors: {
        routes: [
          { host: 'localhost', port: 3000 },
          { host: 'localhost', port: 3000 },
        ],
      },
    },
    { selectors: { domains: ['api.*.example'] } },
    { selectors: { cidrs: ['198.18.5.0/24'] } },
    { selectors: {} },
  ] satisfies Array<Partial<TunnelProcessState>>)('rejects malformed persisted state %#', (overrides) => {
    const state = overrides.status === 'ready' ? makeReadyState(overrides) : makeState(overrides);
    const paths = tunnelProcessPaths(state.instanceId, state.owner, root);
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.state, JSON.stringify(state));
    expect(loadTunnelProcess(state.instanceId, state.owner, root)).toBeUndefined();
  });

  test('uses a bounded hashed path and reads the log tail', () => {
    const paths = tunnelProcessPaths('android_region_secret-customer-id', OWNER_1, root);
    expect(paths.directory).not.toContain('secret-customer-id');
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
    const retiredOwners = [OWNER_1, OWNER_2, OWNER_3];
    for (const [index, owner] of retiredOwners.entries()) {
      const paths = tunnelProcessPaths(INSTANCE_ID, owner, root);
      fs.mkdirSync(paths.directory, { recursive: true });
      fs.writeFileSync(paths.log, owner);
      const modified = new Date(Date.now() + (index + 1) * 1000);
      fs.utimesSync(paths.log, modified, modified);
    }
    const oldestPaths = tunnelProcessPaths(INSTANCE_ID, OWNER_1, root);
    fs.writeFileSync(`${oldestPaths.log}.1`, 'rotated');
    const activeOwner = '4'.repeat(32);
    const active = makeState({ owner: activeOwner, pid: process.pid });
    expect(claimTunnelProcess(active, root)).toBe(true);
    fs.writeFileSync(tunnelProcessPaths(INSTANCE_ID, activeOwner, root).log, 'active');

    pruneTunnelLogs(INSTANCE_ID, root, 2);
    const directory = tunnelProcessPaths(INSTANCE_ID, OWNER_1, root).directory;
    expect(
      fs
        .readdirSync(directory)
        .filter((entry) => entry.endsWith('.log'))
        .sort(),
    ).toEqual([`${OWNER_2}.log`, `${OWNER_3}.log`, `${activeOwner}.log`].sort());
    expect(fs.existsSync(`${oldestPaths.log}.1`)).toBe(false);
  });

  function makeReadyState(overrides: Partial<TunnelProcessState> = {}): TunnelProcessState {
    return makeState({
      pid: 123,
      status: 'ready',
      tunnelId: 'tunnel-1',
      ...overrides,
    });
  }

  function makeState(overrides: Partial<TunnelProcessState>): TunnelProcessState {
    const owner = overrides.owner ?? OWNER_1;
    return {
      owner,
      pid: 0,
      instanceId: INSTANCE_ID,
      product: 'android',
      status: 'starting',
      selectors: { routes: [{ host: '10.20.30.40', port: 8000 }] },
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
