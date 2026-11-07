import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transformFileSync } from '@swc/core';

const loader = transformFileSync(path.join(__dirname, '../packages/cli/src/lib/load-env.ts'), {
  jsc: { parser: { syntax: 'typescript' }, target: 'es2020' },
  module: { type: 'commonjs' },
}).code;

function loadEnv(contents?: string, existingValue?: string, customPath = false): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-cli-env-test-'));
  const env = { ...process.env };
  delete env['LIM_ENV_TEST_VALUE'];
  delete env['LIM_ENV_TEST_EMPTY'];
  delete env['DOTENV_CONFIG_PATH'];
  if (existingValue !== undefined) env['LIM_ENV_TEST_VALUE'] = existingValue;
  if (customPath) env['DOTENV_CONFIG_PATH'] = path.join(dir, '.env.custom');
  try {
    if (contents !== undefined)
      fs.writeFileSync(path.join(dir, customPath ? '.env.custom' : '.env'), contents);
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `${loader}\nprocess.stdout.write(JSON.stringify({value: process.env.LIM_ENV_TEST_VALUE, empty: process.env.LIM_ENV_TEST_EMPTY}));`,
      ],
      { cwd: dir, env, encoding: 'utf8' },
    );
    return JSON.parse(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI starts without a project .env file', () => {
  expect(loadEnv()).toEqual({});
});

test('CLI loads quoted values, comments, exports, and empty values', () => {
  expect(loadEnv('export LIM_ENV_TEST_VALUE="quoted # value" # comment\r\nLIM_ENV_TEST_EMPTY=\r\n')).toEqual({
    value: 'quoted # value',
    empty: '',
  });
});

test.each(['from-shell', ''])('CLI preserves a shell value of %j', (value) => {
  expect(loadEnv('LIM_ENV_TEST_VALUE=from-file\n', value)).toEqual({ value });
});

test('CLI honors a custom .env path', () => {
  expect(loadEnv('LIM_ENV_TEST_VALUE=custom-file\n', undefined, true)).toEqual({ value: 'custom-file' });
});
