import fs from 'fs';
import os from 'os';
import path from 'path';
import { planFolderSync } from '@limrun/api/folder-sync';
import { createIgnore } from '@limrun/api/folder-sync-ignore';

describe('planFolderSync', () => {
  test('lists included files and attributes exclusions; excluded dirs are not descended', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-plan-'));
    fs.writeFileSync(path.join(root, '.gitignore'), 'gen/\n*.log\n');
    fs.writeFileSync(path.join(root, 'main.swift'), 'let x = 1\n');
    fs.writeFileSync(path.join(root, 'debug.log'), 'x\n');
    fs.mkdirSync(path.join(root, 'gen', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'gen', 'deep', 'a.txt'), 'a\n');

    const ignore = await createIgnore(root, {
      basisCacheDir: path.join(os.tmpdir(), 'limsync-plan-basis'),
    });
    const plan = await planFolderSync(root, ignore);

    expect(plan.included.map((f) => f.path)).toEqual(['.gitignore', 'main.swift']);
    expect(plan.excluded).toEqual([
      { path: 'debug.log', source: '.gitignore', rule: '*.log' },
      // gen/ appears exactly once; its contents were never visited.
      { path: 'gen/', source: '.gitignore', rule: 'gen/' },
    ]);
  });
});
