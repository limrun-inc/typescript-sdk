import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectSnapshotConfig, projectSnapshotKey } from './snapshot-project';

let temp: string;
let repo: string;
const writeConfig = (gitDir: string, remote?: string) => {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tbare = false\n' +
      (remote ? `[remote "origin"]\n\turl = ${JSON.stringify(remote)}\n` : ''),
  );
};
const setOrigin = (remote?: string) => writeConfig(path.join(repo, '.git'), remote);

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-snapshot-'));
  repo = path.join(temp, 'local-checkout-name');
  fs.mkdirSync(repo);
  setOrigin('git@github.com:acme/monorepo.git');
  fs.mkdirSync(path.join(repo, 'apps', 'ios'), { recursive: true });
});

afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

test('discovers the project with no Git binary on PATH', () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = temp;
    expect(projectSnapshotKey(path.join(repo, 'apps', 'ios'))).toBe('github.com/acme/monorepo/apps/ios');
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test('parses quoted values, comments, continuations, and case-insensitive setting names', () => {
  fs.writeFileSync(
    path.join(repo, '.git', 'config'),
    [
      '[core]',
      '  editor = "tool \\"arg\\"" # unrelated escaped quotes',
      '[ReMoTe "origin"] ; comment',
      '  URL = "https://user:sec;ret@github.com/acme/\\',
      'monorepo.git" # origin',
      '[remote "other"] url = https://github.com/acme/other.git',
    ].join('\r\n'),
  );
  expect(projectSnapshotKey(repo)).toBe('github.com/acme/monorepo');
});

test('uses the first fetch URL and supports the legacy section spelling', () => {
  fs.writeFileSync(
    path.join(repo, '.git', 'config'),
    [
      '[REMOTE.ORIGIN]',
      'url = https://github.com/acme/monorepo.git',
      'url = https://github.com/acme/mirror.git',
      '[remote "Origin"]',
      'url = https://github.com/acme/uppercase-name.git',
    ].join('\n'),
  );
  expect(projectSnapshotKey(repo)).toBe('github.com/acme/monorepo');
});

test('reads worktree-local origins only when the worktreeConfig extension is enabled', () => {
  setOrigin();
  const gitDir = path.join(repo, '.git');
  fs.writeFileSync(
    path.join(gitDir, 'config.worktree'),
    '[remote "origin"]\nurl = git@github.com:acme/worktree.git\n',
  );
  expect(projectSnapshotKey(repo)).toBeUndefined();
  fs.appendFileSync(path.join(gitDir, 'config'), '[extensions]\nworktreeConfig = true\n');
  expect(projectSnapshotKey(repo)).toBe('github.com/acme/worktree');
});

test.each(['not a gitfile', 'gitdir: missing', 'gitdir: '])(
  'does not escape a broken nested checkout: %s',
  (pointer) => {
    const nested = path.join(repo, 'apps', 'ios');
    fs.writeFileSync(path.join(nested, '.git'), pointer);
    expect(projectSnapshotKey(nested)).toBeUndefined();
  },
);

test.each([
  '[remote "origin"]\nurl = "unterminated',
  '[remote "origin"]\nurl = "https://github.com/acme/\\q"',
  '[remote "origin"\nurl = https://github.com/acme/repo.git',
  '[remote "origin"]\nurl = https://github.com/acme/repo.git\n[include]\npath = other.config',
  '[remote "origin"]\nurl = https://github.com/acme/repo.git\n[includeIf "onbranch:main"]\npath = other.config',
])('leaves malformed or included config to an explicit key: %s', (config) => {
  fs.writeFileSync(path.join(repo, '.git', 'config'), config);
  expect(projectSnapshotConfig({}, repo)).toBeUndefined();
  expect(projectSnapshotConfig({ 'snapshot-key': 'explicit' }, repo)).toEqual({ key: 'explicit' });
});

test.each([
  'git@github.com:Acme/Monorepo.git',
  'ssh://git@github.com/acme/monorepo.git',
  'https://github.com/acme/monorepo.git/',
  'https://user:secret@github.com/acme/monorepo.git?token=secret',
])('normalizes %s to the same project identity', (remote) => {
  setOrigin(remote);
  expect(projectSnapshotKey(repo)).toBe('github.com/acme/monorepo');
  expect(projectSnapshotKey(path.join(repo, 'apps', 'ios'))).toBe('github.com/acme/monorepo/apps/ios');
});

test('preserves case-sensitive repository and app paths on other hosts', () => {
  setOrigin('ssh://git@git.example.com:2222/Acme/Mobile.git');
  fs.mkdirSync(path.join(repo, 'MyApp'));
  expect(projectSnapshotKey(path.join(repo, 'MyApp'))).toBe('git.example.com:2222/Acme/Mobile/MyApp');
});

test.each(['relative', 'absolute'])(
  '%s worktree pointers and symlinked paths share the project key',
  (kind) => {
    const worktree = path.join(temp, 'other-checkout');
    const gitDir = path.join(repo, '.git', 'worktrees', 'other-checkout');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(path.join(worktree, 'apps', 'ios'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${kind === 'absolute' ? gitDir : path.relative(worktree, gitDir)}\n`,
    );
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../../\n');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature\n');
    const linked = path.join(temp, 'linked');
    fs.symlinkSync(worktree, linked, 'junction');
    expect(projectSnapshotKey(path.join(linked, 'apps', 'ios'))).toBe('github.com/acme/monorepo/apps/ios');
  },
);

test('uses the nearest repository for a nested checkout', () => {
  const nested = path.join(repo, 'apps', 'ios');
  writeConfig(path.join(nested, '.git'), 'git@github.com:acme/ios.git');
  expect(projectSnapshotKey(nested)).toBe('github.com/acme/ios');
});

test('follows a submodule gitfile without adopting the containing repository', () => {
  const nested = path.join(repo, 'apps', 'ios');
  const gitDir = path.join(repo, '.git', 'modules', 'apps', 'ios');
  writeConfig(gitDir, 'git@github.com:acme/ios.git');
  fs.writeFileSync(path.join(nested, '.git'), `gitdir: ${path.relative(nested, gitDir)}\n`);
  fs.mkdirSync(path.join(nested, 'Client'));
  expect(projectSnapshotKey(path.join(nested, 'Client'))).toBe('github.com/acme/ios/Client');
});

test.each([
  '/tmp/local-repo',
  'file:///tmp/local-repo',
  'C:\\local\\repo',
  'https://github.com/acme/bad%20name',
])('does not invent an identity for unsupported remote %s', (remote) => {
  setOrigin(remote);
  expect(projectSnapshotKey(repo)).toBeUndefined();
});

test('leaves snapshots explicit without a usable Git origin', () => {
  expect(projectSnapshotConfig({}, temp)).toBeUndefined();
  setOrigin();
  expect(projectSnapshotConfig({}, repo)).toBeUndefined();
  expect(projectSnapshotConfig({ 'snapshot-key': 'my-project' }, temp)).toEqual({ key: 'my-project' });
});

test('does not emit keys beyond the API length limit or with unsupported path characters', () => {
  setOrigin(`https://github.com/acme/${'a'.repeat(255)}.git`);
  expect(projectSnapshotKey(repo)).toBeUndefined();
  setOrigin('https://github.com/acme/repo.git');
  fs.mkdirSync(path.join(repo, 'My App'));
  expect(projectSnapshotKey(path.join(repo, 'My App'))).toBeUndefined();
});

test('defaults to a key alone and preserves explicit keys, restore-only settings and paths', () => {
  expect(projectSnapshotConfig({}, repo)).toEqual({ key: 'github.com/acme/monorepo' });
  expect(projectSnapshotConfig({ 'snapshot-key': 'custom' }, repo)).toEqual({ key: 'custom' });
  expect(projectSnapshotConfig({ 'cache-key': 'legacy' }, repo)).toEqual({ key: 'legacy' });
  expect(projectSnapshotConfig({ 'snapshot-restore-keys': 'main' }, repo)).toEqual({ restoreKeys: ['main'] });
  expect(projectSnapshotConfig({ 'snapshot-paths': 'Pods' }, repo)).toEqual({ paths: ['Pods'] });
  expect(projectSnapshotConfig({ 'no-snapshot': true }, repo)).toBeUndefined();
  expect(() => projectSnapshotConfig({ 'no-snapshot': true, 'cache-key': 'custom' }, repo)).toThrow(
    'cannot be combined',
  );
});
