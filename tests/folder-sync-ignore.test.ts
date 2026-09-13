import fs from 'fs';
import os from 'os';
import path from 'path';
import { createIgnoreFn, type IgnoreFn } from '@limrun/api/folder-sync-ignore';

// Precedence table mirroring the Go harness parity test
// (limrun test/integration/limbuild/folder_sync_ignore_test.go). Layers,
// first decisive answer wins:
//   1. basis cache  2. user include  3. user ignore
//   4. .git/.DS_Store  5. xcode default junk
//   6. built-in force-include (.xcconfig, .env)
//   7. .gitignore chain (root + nested)
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
        '.env*', // proves the .env override beats .gitignore
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
      include: (rel) =>
        rel.startsWith('.git/') || rel.startsWith('apps/foo/Generated/Kit/') || rel.startsWith('pinned/'),
      additional: (rel) =>
        rel === '.env' ||
        rel.startsWith('.env.') ||
        rel === 'Config.xcconfig' ||
        rel === 'apps/foo/.env.local' ||
        rel.startsWith('secrets/') ||
        rel.startsWith('pinned/') ||
        rel.endsWith('important.log'),
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
    // Built-in excludes can be selectively overridden by user include.
    ['.git/HEAD', false, 'user --include rescues the root .git directory'],
    ['a/b/.git/config', true, 'unmatched nested .git stays excluded'],
    ['.DS_Store', true, 'unmatched .DS_Store stays excluded'],
    ['sub/.DS_Store', true, 'unmatched nested .DS_Store stays excluded'],
    // User --ignore overrides built-in force-includes.
    ['Config.xcconfig', true, 'user --ignore excludes a root xcconfig'],
    ['.env', true, 'user --ignore excludes root .env'],
    ['.env.production', true, 'user --ignore excludes root .env.* variants'],
    ['.env.production.local', true, 'user --ignore excludes dotenv-flow variants'],
    ['.env.staging', true, 'user --ignore excludes custom NODE_ENV variants'],
    ['apps/foo/.env.local', true, 'user --ignore excludes a nested .env file'],
    ['public/.env.local', false, 'unmatched nested .env files remain force-included'],
    ['secrets/', true, 'user --ignore prunes a matching parent directory'],
    ['secrets/.env', true, 'an ignored parent prevents .env force-inclusion'],
    ['secrets/Config.xcconfig', true, 'an ignored parent prevents xcconfig force-inclusion'],
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
    // User include force-syncs past nested gitignore and user ignore.
    ['apps/foo/Generated/Kit/Package.swift', false, 'include overrides nested gitignore'],
    // Gitignored generated projects are NOT force-included: limbuild
    // regenerates them from project.yml, and exact-version holdouts
    // force-sync theirs with --include (proven below).
    ['app/App.xcodeproj/project.pbxproj', true, 'gitignored .xcodeproj respects gitignore'],
    ['app/App.xcworkspace/contents.xcworkspacedata', true, 'gitignored .xcworkspace respects gitignore'],
    ['app/App.xcodeproj/', true, 'gitignored .xcodeproj directory is pruned'],
    ['pinned/Exact.xcodeproj/project.pbxproj', false, '--include wins when --ignore also matches'],
    ['pinned/.env', false, '--include wins over --ignore for a built-in force-include path'],
    // Default Xcode/dependency excludes (even if not gitignored).
    ['Pods/Manifest.lock', true, 'Pods/ is a default exclude'],
    ['.swiftpm/x', true, '.swiftpm/ is a default exclude'],
    ['build/out', true, 'build/ is a default exclude'],
    ['DerivedData/x', true, 'DerivedData/ is a default exclude'],
    ['Carthage/Build/x', true, 'Carthage/Build/ is a default exclude'],
    ['sub/build/out', false, 'default dir excludes are root-anchored'],
    ['a/proj.xcodeproj/project.xcworkspace/xcuserdata/u.plist', true, 'xcuserdata anywhere'],
    ['Foo.dSYM/Contents/x', true, '.dSYM anywhere'],
    // Other user ignores remain exclusions.
    ['secrets/key.pem', true, 'user --ignore excludes'],
  ])('ignore(%s) = %s  // %s', (rel, want) => {
    expect(ignore(rel)).toBe(want);
  });

  test('built-in force-includes are unchanged without user ignore', async () => {
    const defaultIgnore = await createIgnoreFn(dir, {
      basisCacheDir: path.join(os.tmpdir(), 'some-other-place'),
      xcodeDefaults: true,
    });

    expect(defaultIgnore('Config.xcconfig')).toBe(false);
    expect(defaultIgnore('.env')).toBe(false);
    expect(defaultIgnore('.env.production.local')).toBe(false);
    expect(defaultIgnore('apps/foo/.env.local')).toBe(false);
  });

  test('basis cache remains excluded when all user predicates match it', async () => {
    const basisCacheDir = path.join(dir, '.limsync-cache');
    const broadInclude = await createIgnoreFn(dir, {
      basisCacheDir,
      xcodeDefaults: true,
      include: () => true,
      additional: () => true,
    });

    expect(broadInclude('.limsync-cache/')).toBe(true);
    expect(broadInclude('.limsync-cache/basis.bin')).toBe(true);
    expect(broadInclude('.git/HEAD')).toBe(false);
  });
});

// The app-bundle install sync calls createIgnoreFn without xcodeDefaults, and
// must keep the legacy behavior: only the root .gitignore is read and no
// default Xcode excludes apply (a build artifact is not reshaped by gitignore
// files embedded in it). With no user ignore, project-file force-includes
// remain unchanged.
describe('createIgnoreFn without xcodeDefaults (app-install legacy mode)', () => {
  let dir: string;
  let ignore: IgnoreFn;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-sync-ignore-legacy-'));
    fs.writeFileSync(path.join(dir, '.gitignore'), ['*.log', '.env*'].join('\n'));
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
    ['Config.xcconfig', false, '.xcconfig remains force-included'],
    ['.env', false, '.env remains force-included'],
    ['Pods/Manifest.lock', false, 'default junk excludes are off without xcodeDefaults'],
  ])('ignore(%s) = %s  // %s', (rel, want) => {
    expect(ignore(rel)).toBe(want);
  });
});
