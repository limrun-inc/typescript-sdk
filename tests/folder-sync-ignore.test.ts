import fs from 'fs';
import os from 'os';
import path from 'path';
import { createIgnoreFn, type IgnoreFn } from '@limrun/api/folder-sync-ignore';

// Precedence table mirroring the Go harness parity test
// (limrun test/integration/limbuild/folder_sync_ignore_test.go). Layers,
// first decisive answer wins:
//   1. .git/.DS_Store/basis-cache  2. user include  3. xcode default junk
//   4. built-in force-include (.xcconfig only)
//   5. .gitignore chain (root + nested)  6. user ignore
describe('createIgnoreFn', () => {
  let dir: string;
  let ignore: IgnoreFn;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-ignore-test-'));
    fs.writeFileSync(
      path.join(dir, '.gitignore'),
      [
        'node_modules/',
        'ios',
        'android',
        '*.log',
        '!keep.log',
        '*.xcconfig', // proves the .xcconfig override beats .gitignore
        '*.xcodeproj', // generated projects, gitignored like Whop-style monorepos
        '*.xcworkspace',
      ].join('\n'),
    );
    // Nested .gitignore: rules bind relative to apps/foo/, and the deeper
    // negation overrides the root *.log rule.
    fs.mkdirSync(path.join(dir, 'apps', 'foo'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'apps', 'foo', '.gitignore'),
      ['.build/', 'Generated/', '!important.log'].join('\n'),
    );
    ignore = await createIgnoreFn(dir, {
      basisCacheDir: path.join(os.tmpdir(), 'some-other-place'),
      xcodeDefaults: true,
      include: (rel) => rel.startsWith('apps/foo/Generated/Kit/') || rel.startsWith('pinned/'),
      // Also excludes apps/foo/important.log, which the nested !important.log
      // negation re-includes: proves --ignore still wins over a gitignore
      // re-include (layer 6 runs after a non-decisive gitignore answer).
      additional: (rel) => rel.startsWith('secrets/') || rel.endsWith('important.log'),
    });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each<[string, boolean, string]>([
    // Dot-files are NOT blanket-skipped.
    ['.npmrc', false, 'npm config must reach the build'],
    ['.xcode.env', false, 'RN build env, not git/DS_Store, not gitignored'],
    ['App.tsx', false, 'ordinary source file'],
    // Always-exclude.
    ['.git/HEAD', true, '.git is always excluded'],
    ['a/b/.git/config', true, 'nested .git is always excluded'],
    ['.DS_Store', true, '.DS_Store is always excluded'],
    ['sub/.DS_Store', true, 'nested .DS_Store is always excluded'],
    // Always-include override.
    ['Config.xcconfig', false, '.xcconfig overrides the *.xcconfig gitignore rule'],
    // Root .gitignore (incl. dir-only rule and negation).
    ['node_modules/', true, 'dir-only gitignore rule prunes the directory'],
    ['node_modules/foo/index.js', true, 'files under a gitignored dir'],
    ['ios/', true, "bare 'ios' rule matches the directory"],
    ['ios/Podfile', true, 'files under gitignored ios/'],
    ['debug.log', true, '*.log gitignore rule'],
    ['keep.log', false, 'negation !keep.log re-includes'],
    // Nested .gitignore, rules relative to apps/foo/.
    ['apps/foo/.build/', true, 'nested .gitignore excludes its .build/'],
    ['apps/foo/.build/manifest.db', true, 'files under nested-excluded dir'],
    ['apps/foo/Generated/', true, 'nested Generated/ rule'],
    ['apps/bar/Generated/x.swift', false, "nested rules don't leak to sibling trees"],
    ['apps/foo/important.log', true, 'user --ignore wins over a gitignore negation re-include'],
    ['apps/foo/debug.log', true, 'root *.log still applies where not negated'],
    // User include force-syncs past nested gitignore.
    ['apps/foo/Generated/Kit/Package.swift', false, 'include overrides nested gitignore'],
    // Gitignored generated projects are NOT force-included: limbuild
    // regenerates them from project.yml, and exact-version holdouts
    // force-sync theirs with --include (proven below).
    ['app/App.xcodeproj/project.pbxproj', true, 'gitignored .xcodeproj respects gitignore'],
    ['app/App.xcworkspace/contents.xcworkspacedata', true, 'gitignored .xcworkspace respects gitignore'],
    ['app/App.xcodeproj/', true, 'gitignored .xcodeproj directory is pruned'],
    ['pinned/Exact.xcodeproj/project.pbxproj', false, '--include rescues a gitignored .xcodeproj'],
    // Default Xcode/dependency excludes (even if not gitignored).
    ['Pods/Manifest.lock', true, 'Pods/ is a default exclude'],
    ['.swiftpm/x', true, '.swiftpm/ is a default exclude'],
    ['build/out', true, 'build/ is a default exclude'],
    ['DerivedData/x', true, 'DerivedData/ is a default exclude'],
    ['Carthage/Build/x', true, 'Carthage/Build/ is a default exclude'],
    ['sub/build/out', false, 'default dir excludes are root-anchored'],
    ['a/proj.xcodeproj/project.xcworkspace/xcuserdata/u.plist', true, 'xcuserdata anywhere'],
    ['Foo.dSYM/Contents/x', true, '.dSYM anywhere'],
    // User ignore runs last.
    ['secrets/key.pem', true, 'user --ignore excludes'],
    ['secrets/Config.xcconfig', false, 'built-in force-include beats user --ignore (existing behavior)'],
  ])('ignore(%s) = %s  // %s', (rel, want) => {
    expect(ignore(rel)).toBe(want);
  });
});

// The app-bundle install sync calls createIgnoreFn without xcodeDefaults, and
// must keep the legacy behavior: only the root .gitignore is read and no
// default Xcode excludes apply (a build artifact is not reshaped by gitignore
// files embedded in it). .xcconfig force-include stays unconditional, as it
// always was.
describe('createIgnoreFn without xcodeDefaults (app-install legacy mode)', () => {
  let dir: string;
  let ignore: IgnoreFn;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-ignore-legacy-'));
    fs.writeFileSync(path.join(dir, '.gitignore'), ['*.log'].join('\n'));
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', '.gitignore'), ['keep.txt'].join('\n'));
    ignore = await createIgnoreFn(dir, {
      basisCacheDir: path.join(os.tmpdir(), 'some-other-place'),
    });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each<[string, boolean, string]>([
    ['root.log', true, 'root .gitignore still applies'],
    ['nested/keep.txt', false, 'nested .gitignore is NOT honored in legacy mode'],
    ['App.xcodeproj/project.pbxproj', false, 'gitignored-or-not, no rule excludes it here'],
    ['Config.xcconfig', false, '.xcconfig force-include is unconditional'],
    ['Pods/Manifest.lock', false, 'default junk excludes are off without xcodeDefaults'],
  ])('ignore(%s) = %s  // %s', (rel, want) => {
    expect(ignore(rel)).toBe(want);
  });
});
