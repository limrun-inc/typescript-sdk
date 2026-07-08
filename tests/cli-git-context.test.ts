import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { readGitContext } from '../packages/cli/src/lib/git-context';

describe('readGitContext', () => {
  test('returns undefined outside a git checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-git-ctx-'));
    expect(readGitContext(dir)).toBeUndefined();
  });

  test('captures commit, branch, and dirty state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-git-ctx-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm i', {
      cwd: dir,
    });

    const clean = readGitContext(dir);
    expect(clean?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(clean?.branch).toBe('main');
    expect(clean?.dirty).toBe(false);

    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    expect(readGitContext(dir)?.dirty).toBe(true);
  });
});
