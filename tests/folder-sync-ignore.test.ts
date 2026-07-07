import fs from 'fs';
import os from 'os';
import path from 'path';
import { createIgnore, type SyncIgnore } from '@limrun/api/folder-sync-ignore';

type Tree = Record<string, string>;

function makeTree(tree: Tree): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limsync-ignore-'));
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

async function ignoreFor(root: string, additional?: { source: string; fn: (rel: string) => boolean }[]) {
  return createIgnore(root, {
    basisCacheDir: path.join(os.tmpdir(), 'limsync-ignore-basis'),
    ...(additional && { additional }),
  });
}

function ignored(ig: SyncIgnore, rel: string): boolean {
  return ig.ignores(rel);
}

describe('createIgnore', () => {
  test('root .gitignore still applies (regression)', async () => {
    const root = makeTree({ '.gitignore': '*.log\nbuild/\n', 'a.log': '', 'src/main.swift': '' });
    const ig = await ignoreFor(root);
    expect(ignored(ig, 'a.log')).toBe(true);
    expect(ignored(ig, 'build/')).toBe(true);
    expect(ignored(ig, 'src/main.swift')).toBe(false);
  });

  test('nested .gitignore scopes to its own directory', async () => {
    const root = makeTree({ 'sub/.gitignore': '*.log\n', 'sub/a.log': '', 'a.log': '' });
    const ig = await ignoreFor(root);
    expect(ignored(ig, 'sub/a.log')).toBe(true);
    expect(ignored(ig, 'a.log')).toBe(false);
  });

  test('deeper .gitignore overrides shallower', async () => {
    const root = makeTree({
      '.gitignore': '*.gen\n',
      'sub/.gitignore': '!keep.gen\n',
      'sub/keep.gen': '',
      'sub/other.gen': '',
      'toplevel.gen': '',
    });
    const ig = await ignoreFor(root);
    expect(ignored(ig, 'sub/keep.gen')).toBe(false);
    expect(ignored(ig, 'sub/other.gen')).toBe(true);
    expect(ignored(ig, 'toplevel.gen')).toBe(true);
  });

  test('contents of an ignored directory cannot be re-included', async () => {
    const root = makeTree({
      '.gitignore': 'gen/\n',
      'gen/.gitignore': '!keep.txt\n',
      'gen/keep.txt': '',
    });
    const ig = await ignoreFor(root);
    expect(ignored(ig, 'gen/')).toBe(true);
    expect(ignored(ig, 'gen/keep.txt')).toBe(true);
  });

  test('.limignore adds sync-only exclusions and can re-include gitignored paths', async () => {
    const root = makeTree({
      '.gitignore': '*.xcodeproj\n',
      '.limignore': 'artifacts/\n!*.xcodeproj\n',
      'artifacts/big.bin': '',
      'App.xcodeproj/project.pbxproj': '',
    });
    const ig = await ignoreFor(root);
    expect(ignored(ig, 'artifacts/')).toBe(true);
    expect(ignored(ig, 'App.xcodeproj/')).toBe(false);
  });

  test('pattern files cannot re-include the hard built-ins', async () => {
    const root = makeTree({ '.limignore': '!.git\n!.git/**\n!.DS_Store\n', '.gitignore': '' });
    const ig = await ignoreFor(root);
    expect(ignored(ig, '.git/')).toBe(true);
    expect(ignored(ig, '.git/HEAD')).toBe(true);
    expect(ignored(ig, 'sub/.DS_Store')).toBe(true);
    expect(ignored(ig, '.limsync-meta.json')).toBe(true);
  });

  test('.xcconfig force-include still wins over .gitignore', async () => {
    const root = makeTree({ '.gitignore': '*.xcconfig\n', 'Config/Release.xcconfig': '' });
    const ig = await ignoreFor(root);
    expect(ignored(ig, 'Config/Release.xcconfig')).toBe(false);
  });

  test('explain() attributes the deciding layer and rule', async () => {
    const root = makeTree({
      '.gitignore': '*.log\n',
      'Modules/Feature/.gitignore': '*.xcodeproj\n',
      '.limignore': 'caches/\n',
      'Modules/Feature/Gen.xcodeproj/x': '',
      'a.log': '',
      'caches/f': '',
    });
    const ig = await ignoreFor(root, [
      { source: 'xcode-defaults', fn: (rel) => rel.startsWith('DerivedData/') },
    ]);

    expect(ig.explain('.git/')).toEqual({ ignored: true, source: 'built-in' });
    expect(ig.explain('a.log')).toEqual({ ignored: true, source: '.gitignore', rule: '*.log' });
    expect(ig.explain('Modules/Feature/Gen.xcodeproj/')).toEqual({
      ignored: true,
      source: 'Modules/Feature/.gitignore',
      rule: '*.xcodeproj',
    });
    expect(ig.explain('caches/')).toEqual({ ignored: true, source: '.limignore', rule: 'caches/' });
    expect(ig.explain('DerivedData/foo')).toEqual({ ignored: true, source: 'xcode-defaults' });
    expect(ig.explain('src/kept.swift')).toEqual({ ignored: false });
  });

  test('warns once per rule when a git-tracked path is dropped', async () => {
    const root = makeTree({ 'ios/a.swift': '', 'ios/b.swift': '' });
    const { execSync } = await import('child_process');
    execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm i', { cwd: root });
    // Rule added AFTER the paths were tracked: the divergence the warning exists for.
    fs.writeFileSync(path.join(root, '.gitignore'), 'ios/\n');
    const warnings: string[] = [];
    const ig = await createIgnore(root, {
      basisCacheDir: path.join(os.tmpdir(), 'limsync-ignore-basis'),
      log: (level, msg) => {
        if (level === 'warn') warnings.push(msg);
      },
    });
    expect(ig.ignores('ios/')).toBe(true);
    expect(ig.ignores('ios/a.swift')).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("'ios/'");
  });
});
