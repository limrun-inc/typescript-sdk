import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractAppArchiveToStablePath, prepareAppBundlePath, watchAppArchive } from '../src/app-archive';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-app-archive-test-'));
}

function writeIpa(ipaPath: string, appName: string, files: Record<string, string>): void {
  const root = tempDir();
  const appDir = path.join(root, 'Payload', appName);
  fs.mkdirSync(appDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(appDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  fs.rmSync(ipaPath, { force: true });
  execFileSync('zip', ['-qry', ipaPath, 'Payload'], { cwd: root });
}

function writeZip(root: string, zipPath: string, args: string[]): void {
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-qry', zipPath, ...args], { cwd: root });
}

describe('app archive preparation', () => {
  test('returns app directories unchanged', async () => {
    const appDir = path.join(tempDir(), 'Example.app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), 'plist');

    await expect(prepareAppBundlePath(appDir)).resolves.toMatchObject({
      appPath: appDir,
      cacheIdentityPath: appDir,
      isArchive: false,
    });
  });

  test('extracts an IPA to a stable app path derived from the archive path', async () => {
    const work = tempDir();
    const ipaPath = path.join(work, 'TargetName.ipa');
    writeIpa(ipaPath, 'BundleName.app', {
      'Info.plist': 'plist',
      'Resources/data.txt': 'first',
    });

    const first = await extractAppArchiveToStablePath(ipaPath);
    const second = await extractAppArchiveToStablePath(ipaPath);

    expect(first.appPath).toBe(second.appPath);
    expect(path.basename(first.appPath)).toBe('Extracted.app');
    expect(first.cacheIdentityPath).toBe(path.resolve(ipaPath));
    expect(fs.readFileSync(path.join(first.appPath, 'Info.plist'), 'utf8')).toBe('plist');
    expect(fs.readFileSync(path.join(first.appPath, 'Resources', 'data.txt'), 'utf8')).toBe('first');
  });

  test('re-extracting removes files that disappeared from the archive', async () => {
    const work = tempDir();
    const ipaPath = path.join(work, 'Changing.ipa');
    writeIpa(ipaPath, 'Changing.app', {
      'Info.plist': 'plist',
      'stale.txt': 'remove me',
    });
    const first = await extractAppArchiveToStablePath(ipaPath);
    expect(fs.existsSync(path.join(first.appPath, 'stale.txt'))).toBe(true);

    writeIpa(ipaPath, 'Changing.app', {
      'Info.plist': 'plist',
      'fresh.txt': 'new',
    });
    const second = await extractAppArchiveToStablePath(ipaPath);

    expect(second.appPath).toBe(first.appPath);
    expect(fs.existsSync(path.join(second.appPath, 'stale.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(second.appPath, 'fresh.txt'), 'utf8')).toBe('new');
  });

  test('rejects non-zip files', async () => {
    const filePath = path.join(tempDir(), 'not-an-app.txt');
    fs.writeFileSync(filePath, 'hello');

    await expect(prepareAppBundlePath(filePath)).rejects.toThrow(
      /not a valid app bundle directory or ZIP\/IPA archive/,
    );
  });

  test('rejects zips with no Payload app bundle', async () => {
    const work = tempDir();
    fs.writeFileSync(path.join(work, 'file.txt'), 'hello');
    const zipPath = path.join(work, 'bad.ipa');
    writeZip(work, zipPath, ['file.txt']);

    await expect(extractAppArchiveToStablePath(zipPath)).rejects.toThrow(
      /contains no Payload\/\*\.app bundle/,
    );
  });

  test('rejects zips with multiple Payload app bundles', async () => {
    const work = tempDir();
    fs.mkdirSync(path.join(work, 'Payload', 'One.app'), { recursive: true });
    fs.mkdirSync(path.join(work, 'Payload', 'Two.app'), { recursive: true });
    fs.writeFileSync(path.join(work, 'Payload', 'One.app', 'Info.plist'), 'one');
    fs.writeFileSync(path.join(work, 'Payload', 'Two.app', 'Info.plist'), 'two');
    const zipPath = path.join(work, 'bad.ipa');
    writeZip(work, zipPath, ['Payload']);

    await expect(extractAppArchiveToStablePath(zipPath)).rejects.toThrow(
      /more than one Payload\/\*\.app bundle/,
    );
  });

  test('rejects zip-slip entries', async () => {
    const work = tempDir();
    fs.mkdirSync(path.join(work, 'inside'), { recursive: true });
    fs.writeFileSync(path.join(work, 'outside.txt'), 'escape');
    const zipPath = path.join(work, 'evil.ipa');
    writeZip(path.join(work, 'inside'), zipPath, ['../outside.txt']);

    await expect(extractAppArchiveToStablePath(zipPath)).rejects.toThrow(/unsafe path|invalid relative path/);
  });

  test('rejects symlinks that escape the extracted app bundle', async () => {
    const work = tempDir();
    const appDir = path.join(work, 'Payload', 'Evil.app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'Info.plist'), 'plist');
    fs.symlinkSync('../../outside.txt', path.join(appDir, 'escape'));
    const zipPath = path.join(work, 'evil.ipa');
    fs.rmSync(zipPath, { force: true });
    execFileSync('zip', ['-qry', '-y', zipPath, 'Payload'], { cwd: work });

    await expect(extractAppArchiveToStablePath(zipPath)).rejects.toThrow(/symlink escapes app bundle/);
  });

  test('archive watcher can be closed', () => {
    const close = jest.fn();
    const watchSpy = jest.spyOn(fs, 'watch').mockImplementation(() => ({ close }) as unknown as fs.FSWatcher);
    const archivePath = path.join(tempDir(), 'WatchMe.ipa');
    fs.writeFileSync(archivePath, 'not used by this test');

    const watcher = watchAppArchive({ archivePath });
    watcher.close();

    expect(watchSpy).toHaveBeenCalledWith(path.dirname(archivePath), expect.any(Function));
    expect(close).toHaveBeenCalled();
    watchSpy.mockRestore();
  });
});
