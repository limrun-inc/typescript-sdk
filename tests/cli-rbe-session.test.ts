import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { RbeStatus } from '@limrun/api';
import {
  assertLocalPortFree,
  buildServeChildArgs,
  clearRbePidFile,
  isProcessAlive,
  isTransientError,
  readRbePidFile,
  retryTransient,
  waitForRbeRunning,
  writeRbePidFile,
} from '../packages/cli/src/lib/rbe-session';

const noSleep = async () => {};

describe('isTransientError (#4 discrimination)', () => {
  test('treats the `failed: <code>` shape from directInstanceHttpError as transient', () => {
    expect(isTransientError(new Error('POST /rbe failed: 502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('GET /rbe failed: 503'))).toBe(true);
  });
  test('treats fetch/network error names as transient', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('request to … failed, reason: ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });
  test('does NOT treat a bare 502 buried in a body or id as transient', () => {
    // The whole point of anchoring on `failed: <code>`: a 502/503/504 that is
    // NOT the actual HTTP status (an instance id, or text inside a 500 body)
    // must not be mistaken for a transient gateway error.
    expect(isTransientError(new Error('instance sandbox_502abc was not found'))).toBe(false);
    expect(isTransientError(new Error('POST /rbe failed: 500 (body mentions 502)'))).toBe(false);
  });
  test('a plain non-transient error is not retried', () => {
    expect(isTransientError(new Error('boom'))).toBe(false);
  });
});

describe('retryTransient', () => {
  test('retries a transient failure then returns the eventual success', async () => {
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('POST /rbe failed: 502'))
      .mockResolvedValueOnce('ok');
    await expect(retryTransient(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('rethrows a non-transient error immediately without retrying', async () => {
    const fn = jest.fn(async () => {
      throw new Error('Remote build execution is not available');
    });
    await expect(retryTransient(fn, { sleep: noSleep })).rejects.toThrow(/not available/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws the last error after exhausting attempts', async () => {
    const fn = jest.fn(async () => {
      throw new Error('GET /rbe failed: 503');
    });
    await expect(retryTransient(fn, { sleep: noSleep, attempts: 3 })).rejects.toThrow(/failed: 503/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('waitForRbeRunning', () => {
  function clientReturning(seq: RbeStatus[]) {
    const getRbe = jest.fn(async () => seq.shift() as RbeStatus);
    return { getRbe };
  }

  test('returns immediately when the initial status is already running', async () => {
    const client = clientReturning([]);
    const status = await waitForRbeRunning(
      client,
      { state: 'running', frontendPort: 8980, xcodeVersion: '26.4.0.17E192' },
      { sleep: noSleep },
    );
    expect(status.frontendPort).toBe(8980);
    expect(client.getRbe).not.toHaveBeenCalled();
  });

  test('polls through starting until running', async () => {
    const client = clientReturning([
      { state: 'starting' },
      { state: 'running', frontendPort: 8980, xcodeVersion: '26.4.0.17E192' },
    ]);
    const status = await waitForRbeRunning(client, { state: 'starting' }, { sleep: noSleep });
    expect(status.xcodeVersion).toBe('26.4.0.17E192');
    expect(client.getRbe).toHaveBeenCalledTimes(2);
  });

  test('throws when the stack ends in failed, surfacing the error', async () => {
    const client = clientReturning([{ state: 'failed', error: 'worker crashed' }]);
    await expect(waitForRbeRunning(client, { state: 'starting' }, { sleep: noSleep })).rejects.toThrow(
      /worker crashed/,
    );
  });

  test('throws when it stays starting past maxAttempts', async () => {
    const client = { getRbe: jest.fn(async () => ({ state: 'starting' }) as RbeStatus) };
    await expect(
      waitForRbeRunning(client, { state: 'starting' }, { sleep: noSleep, maxAttempts: 3 }),
    ).rejects.toThrow(/state is starting/);
    expect(client.getRbe).toHaveBeenCalledTimes(3);
  });

  test('throws when running but missing frontendPort (would otherwise leak undefined into the BUILD pin)', async () => {
    const client = clientReturning([]);
    await expect(
      waitForRbeRunning(client, { state: 'running', xcodeVersion: '26.4.0.17E192' }, { sleep: noSleep }),
    ).rejects.toThrow(/failed to start/);
  });
});

describe('buildServeChildArgs', () => {
  test('builds the serve child argv with id and port, and --no-create (child never creates instances)', () => {
    expect(buildServeChildArgs({ scriptPath: '/bin/lim', id: 'xc_1', port: 8980 })).toEqual([
      '/bin/lim',
      'xcode',
      'rbe',
      '--serve',
      '--no-create',
      '--id',
      'xc_1',
      '--port',
      '8980',
    ]);
  });

  test('passes through the api key when provided, omits it otherwise', () => {
    expect(
      buildServeChildArgs({ scriptPath: '/bin/lim', id: 'xc_1', port: 9980, apiKey: 'lim_k' }),
    ).toContain('lim_k');
    expect(buildServeChildArgs({ scriptPath: '/bin/lim', id: 'xc_1', port: 9980 })).not.toContain(
      '--api-key',
    );
  });
});

describe('rbe pidfile helpers', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbe-pid-'));
    fs.mkdirSync(path.join(dir, '.limrun'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('write/read round trips the pid info', () => {
    writeRbePidFile(dir, { pid: 4321, instanceId: 'xc_1', port: 8980 });
    expect(readRbePidFile(dir)).toEqual({ pid: 4321, instanceId: 'xc_1', port: 8980 });
  });

  test('read returns null when absent or malformed', () => {
    expect(readRbePidFile(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '.limrun', 'rbe.pid'), 'not json');
    expect(readRbePidFile(dir)).toBeNull();
  });

  test('clear removes the pidfile (and is a no-op when already gone)', () => {
    writeRbePidFile(dir, { pid: 1, instanceId: 'xc_1', port: 8980 });
    clearRbePidFile(dir);
    expect(readRbePidFile(dir)).toBeNull();
    expect(() => clearRbePidFile(dir)).not.toThrow();
  });

  test('isProcessAlive reflects this process and a dead pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // A pid that is essentially never live in a test environment.
    expect(isProcessAlive(2147483647)).toBe(false);
  });
});

describe('assertLocalPortFree', () => {
  test('rejects with a friendly message when the port is already in use', async () => {
    const occupier = net.createServer();
    await new Promise<void>((resolve) => occupier.listen(0, '127.0.0.1', () => resolve()));
    const port = (occupier.address() as net.AddressInfo).port;
    await expect(assertLocalPortFree(port)).rejects.toThrow(/already in use/);
    await new Promise<void>((resolve) => occupier.close(() => resolve()));
  });

  test('resolves for a free port and leaves it bindable afterwards', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    await expect(assertLocalPortFree(port)).resolves.toBeUndefined();

    const after = net.createServer();
    await expect(
      new Promise<void>((resolve, reject) => {
        after.once('error', reject);
        after.listen(port, '127.0.0.1', () => resolve());
      }),
    ).resolves.toBeUndefined();
    await new Promise<void>((resolve) => after.close(() => resolve()));
  });
});
