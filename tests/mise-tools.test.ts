import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parseToolRequests, readMiseDefaults, writeMiseTools } from '../src/mise-tools';

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lim-mise-test-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

test('records compatibility lines and excludes Apple and Homebrew tools', () => {
  expect(parseToolRequests(['node@24.5.0', 'ruby@3.3.7', 'pnpm@10.12.1', 'mint@0.18.0'])).toEqual({
    node: '24',
    ruby: '3.3',
    pnpm: '10',
    mint: '0.18',
  });
  expect(() => parseToolRequests(['ruby@3'])).toThrow('major.minor');
  expect(parseToolRequests(['node@latest'])).toEqual({ node: 'latest' });
  expect(() => parseToolRequests(['xcode@27'])).toThrow('separately');
  expect(() => parseToolRequests(["node';echo@24"])).toThrow('Invalid tool');
});

test('updates the effective project file while preserving unrelated configuration values', async () => {
  await fs.writeFile(path.join(directory, 'mise.toml'), '[tools]\nnode="22"\n');
  await fs.writeFile(
    path.join(directory, 'mise.local.toml'),
    '[tools]\nruby="3.3"\nnodejs="22"\n[env]\nMESSAGE="kept local"\n[tasks.generate]\nrun="echo yes"\n',
  );
  const file = await writeMiseTools(directory, { node: '24' });
  expect(file).toBe(path.join(directory, 'mise.local.toml'));
  expect(await readMiseDefaults(file)).toEqual({ ruby: '3.3', node: '24' });
  expect(await fs.readFile(file, 'utf8')).toContain('kept local');
  expect(await fs.readFile(file, 'utf8')).toContain('echo yes');
  expect(await fs.readFile(path.join(directory, 'mise.toml'), 'utf8')).toContain('22');
});

test('personal defaults transmit only tool requests and fail visibly on invalid TOML', async () => {
  const file = path.join(directory, 'global.toml');
  expect(await readMiseDefaults(file)).toEqual({});
  await fs.writeFile(file, '[tools]\nnode="24.5.0"\n[env]\nTOKEN="do not send"\n');
  expect(await readMiseDefaults(file)).toEqual({ node: '24.5.0' });
  await fs.writeFile(file, '[invalid');
  await expect(readMiseDefaults(file)).rejects.toThrow('Cannot read mise configuration');
});
