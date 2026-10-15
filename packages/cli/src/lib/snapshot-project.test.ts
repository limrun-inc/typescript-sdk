import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectSnapshotConfig, projectSnapshotKey } from './snapshot-project';

let temp: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-snapshot-'));
  repo = path.join(temp, 'local-checkout-name');
  fs.mkdirSync(repo);
  git('init');
  git('remote', 'add', 'origin', 'git@github.com:acme/monorepo.git');
  fs.mkdirSync(path.join(repo, 'apps', 'ios'), { recursive: true });
});

afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

test.each([
  'git@github.com:Acme/Monorepo.git',
  'ssh://git@github.com/acme/monorepo.git',
  'https://github.com/acme/monorepo.git/',
  'https://user:secret@github.com/acme/monorepo.git?token=secret',
])('normalizes %s to the same project identity', (remote) => {
  git('remote', 'set-url', 'origin', remote);
  expect(projectSnapshotKey(repo)).toBe('github.com/acme/monorepo');
  expect(projectSnapshotKey(path.join(repo, 'apps', 'ios'))).toBe('github.com/acme/monorepo/apps/ios');
});

test('preserves case-sensitive repository and app paths on other hosts', () => {
  git('remote', 'set-url', 'origin', 'ssh://git@git.example.com:2222/Acme/Mobile.git');
  fs.mkdirSync(path.join(repo, 'MyApp'));
  expect(projectSnapshotKey(path.join(repo, 'MyApp'))).toBe('git.example.com:2222/Acme/Mobile/MyApp');
});

test('linked worktrees and symlinked paths share the project key', () => {
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
  const worktree = path.join(temp, 'other-checkout');
  git('worktree', 'add', '-b', 'feature', worktree);
  fs.mkdirSync(path.join(worktree, 'apps', 'ios'), { recursive: true });
  const linked = path.join(temp, 'linked');
  fs.symlinkSync(worktree, linked, 'junction');
  expect(projectSnapshotKey(path.join(linked, 'apps', 'ios'))).toBe('github.com/acme/monorepo/apps/ios');
});

test('uses the nearest repository for a nested checkout', () => {
  const nested = path.join(repo, 'apps', 'ios');
  execFileSync('git', ['init'], { cwd: nested, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/ios.git'], {
    cwd: nested,
    stdio: 'ignore',
  });
  expect(projectSnapshotKey(nested)).toBe('github.com/acme/ios');
});

test.each([
  '/tmp/local-repo',
  'file:///tmp/local-repo',
  'C:\\local\\repo',
  'https://github.com/acme/bad%20name',
])('does not invent an identity for unsupported remote %s', (remote) => {
  git('remote', 'set-url', 'origin', remote);
  expect(projectSnapshotKey(repo)).toBeUndefined();
});

test('leaves snapshots explicit without a usable Git origin', () => {
  expect(projectSnapshotConfig({}, temp)).toBeUndefined();
  git('remote', 'remove', 'origin');
  expect(projectSnapshotConfig({}, repo)).toBeUndefined();
  expect(projectSnapshotConfig({ 'snapshot-key': 'my-project' }, temp)).toEqual({ key: 'my-project' });
});

test('does not emit keys beyond the API length limit or with unsupported path characters', () => {
  git('remote', 'set-url', 'origin', `https://github.com/acme/${'a'.repeat(255)}.git`);
  expect(projectSnapshotKey(repo)).toBeUndefined();
  git('remote', 'set-url', 'origin', 'https://github.com/acme/repo.git');
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
