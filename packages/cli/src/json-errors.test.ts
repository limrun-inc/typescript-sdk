import { spawnSync } from 'child_process';
import path from 'path';

const { handleJsonError } = require('../bin/json-errors.cjs');

afterEach(() => jest.restoreAllMocks());

test('JSON errors have stable fields and preserve HTTP status', () => {
  const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const oldExit = process.exitCode;
  try {
    expect(handleJsonError(Object.assign(new Error('Not found'), { status: 404 }), ['get', '--json'])).toBe(
      true,
    );
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({
      error: { code: 'CLI_ERROR', message: 'Not found', status: 404 },
    });
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = oldExit;
  }
});

test('a forwarded --json is not a CLI flag', () => {
  expect(handleJsonError(new Error('failed'), ['ios', 'simctl', '--', 'listapps', '--json'])).toBe(false);
});

test('an explicit exit preserves the code without inventing a second result', () => {
  const write = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const oldExit = process.exitCode;
  try {
    expect(handleJsonError({ code: 'EEXIT', oclif: { exit: 7 } }, ['--json'])).toBe(true);
    expect(process.exitCode).toBe(7);
    expect(write).not.toHaveBeenCalled();
  } finally {
    process.exitCode = oldExit;
  }
});

test.each([
  ['android', 'tap', '--json'],
  ['android', 'create', '--json', '--does-not-exist'],
  ['not-a-command', '--json'],
])('the real CLI returns JSON errors for %j', (...args) => {
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/run.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe('');
  expect(JSON.parse(run.stderr)).toEqual({
    error: { code: expect.any(String), message: expect.any(String) },
  });
});
