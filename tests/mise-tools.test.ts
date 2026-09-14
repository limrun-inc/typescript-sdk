import compatibilityCases from './fixtures/mise-compatibility.json';
import fs from 'fs/promises';
import { parse } from 'smol-toml';
import os from 'os';
import path from 'path';
import { parseToolRequests, writeMiseTools, toolCompatibilityLine } from '../src/mise-tools';

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
  expect(parseToolRequests(['java@jetbrains-21.0.11-b1163.116'])).toEqual({ java: 'jetbrains-21' });
  expect(parseToolRequests(['java@jbr-21'])).toEqual({ java: 'jetbrains-21' });
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
  expect(parse(await fs.readFile(file, 'utf8'))['tools']).toEqual({ ruby: '3.3', node: '24' });
  expect(await fs.readFile(file, 'utf8')).toContain('kept local');
  expect(await fs.readFile(file, 'utf8')).toContain('echo yes');
  expect(await fs.readFile(path.join(directory, 'mise.toml'), 'utf8')).toContain('22');
});

test.each(compatibilityCases)('shared compatibility contract: $name@$input', ({ name, input, expected }) => {
  if (expected === null) expect(() => toolCompatibilityLine(name, input)).toThrow();
  else expect(toolCompatibilityLine(name, input)).toBe(expected);
});
