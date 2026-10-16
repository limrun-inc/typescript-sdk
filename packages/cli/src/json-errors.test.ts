import { spawnSync } from 'child_process';
import path from 'path';

const { handleJsonError } = require('../bin/json-errors.cjs');

test('a forwarded --json is not a CLI flag', async () => {
  await expect(
    handleJsonError(new Error('failed'), ['ios', 'simctl', '--', 'listapps', '--json']),
  ).resolves.toBe(false);
});

// Exercise real process termination and pipe flushing with a live socket. Parser-only
// failures have no open connections and cannot detect a handler that merely sets exitCode.
test.each([
  { explicit: false, exitCode: 1 },
  { explicit: true, exitCode: 7 },
  { explicit: true, exitCode: 0 },
])('JSON errors exit with an open connection: %j', ({ explicit, exitCode }) => {
  const handlerPath = path.resolve(__dirname, '../bin/json-errors.cjs');
  const payload = 'x'.repeat(256 * 1024);
  const script = String.raw`
    const net = require('net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      socket.once('connect', () => {
        process.stdout.write(JSON.stringify({ stdout: 'x'.repeat(256 * 1024) }) + '\n');
        const error = ${
          explicit ?
            `{ code: 'EEXIT', oclif: { exit: ${exitCode} } }`
          : "Object.assign(new Error('x'.repeat(256 * 1024)), { status: 404 })"
        };
        require(${JSON.stringify(handlerPath)}).handleJsonError(error, ['--json']);
      });
    });
  `;
  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.status).toBe(exitCode);
  expect(JSON.parse(run.stdout)).toEqual({ stdout: payload });
  if (explicit) expect(run.stderr).toBe('');
  else
    expect(JSON.parse(run.stderr)).toEqual({ error: { code: 'CLI_ERROR', message: payload, status: 404 } });
});

test.each(['run.js', 'dev.js'])('%s terminates JSON failures with an open handle', (entrypoint) => {
  const entrypointPath = path.resolve(__dirname, '../bin', entrypoint);
  const run = spawnSync(
    process.execPath,
    [
      '-e',
      `
    setInterval(() => {}, 60000);
    process.argv = [process.execPath, ${JSON.stringify(entrypointPath)}, 'android', 'tap', '--json'];
    require(${JSON.stringify(entrypointPath)});
  `,
    ],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, NO_COLOR: '1' } },
  );
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.status).toBe(2);
  expect(run.stdout).toBe('');
  expect(JSON.parse(run.stderr)).toEqual({
    error: { code: expect.any(String), message: expect.stringContaining('Missing') },
  });
});

test.each([
  ['android', 'tap', '--json'],
  ['android', 'create', '--json', '--does-not-exist'],
  ['not-a-command', '--json'],
])('the real CLI returns JSON errors for %j', (...args) => {
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/run.js'), ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe('');
  expect(JSON.parse(run.stderr)).toEqual({
    error: { code: expect.any(String), message: expect.any(String) },
  });
});

test('the production entrypoint retains human-readable errors without --json', () => {
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/run.js'), 'android', 'tap'], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(2);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('Missing');
  expect(run.stderr).toContain('USAGE');
});
