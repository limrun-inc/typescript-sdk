import fs from 'fs/promises';
import { parse } from 'smol-toml';
import os from 'os';
import path from 'path';
import { parseToolRequests, writeMiseTools } from '../src/mise-tools';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lim-mise-test-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

test('preserves requested tool names and versions for server interpretation', () => {
  expect(parseToolRequests(['nodejs@24.5.0', 'ruby@3.3.7', 'pnpm@10.12.1', 'mint@0.18.0'])).toEqual({
    nodejs: '24.5.0',
    ruby: '3.3.7',
    pnpm: '10.12.1',
    mint: '0.18.0',
  });
  expect(parseToolRequests(['ruby@3'])).toEqual({ ruby: '3' });
  expect(parseToolRequests(['node@latest'])).toEqual({ node: 'latest' });
  expect(parseToolRequests(['jdk@jbr-21.0.11+1163.116'])).toEqual({ jdk: 'jbr-21.0.11+1163.116' });
  expect(parseToolRequests(['node@lts', 'swift@6'])).toEqual({ node: 'lts', swift: '6' });
});

test.each(['node', '@24', 'node@', 'node@ ', "node';echo@24"])('rejects malformed request %s', (request) => {
  expect(() => parseToolRequests([request])).toThrow();
});

test('updates the effective project file while preserving unrelated configuration values', async () => {
  await fs.writeFile(path.join(directory, 'mise.toml'), '[tools]\nnode="22"\n');
  await fs.writeFile(
    path.join(directory, 'mise.local.toml'),
    '[tools]\nruby="3.3"\nnodejs="22"\n[env]\nMESSAGE="kept local"\n[tasks.generate]\nrun="echo yes"\n',
  );
  const file = await writeMiseTools(directory, parseToolRequests(['nodejs@24.5.0']));
  expect(file).toBe(path.join(directory, 'mise.local.toml'));
  expect(parse(await fs.readFile(file, 'utf8'))['tools']).toEqual({ ruby: '3.3', nodejs: '24.5.0' });
  expect(await fs.readFile(file, 'utf8')).toContain('kept local');
  expect(await fs.readFile(file, 'utf8')).toContain('echo yes');
  expect(await fs.readFile(path.join(directory, 'mise.toml'), 'utf8')).toContain('22');
});
