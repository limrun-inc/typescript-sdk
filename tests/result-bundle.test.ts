import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractZipToDirectory } from '../src/app-archive';
import { pullResultBundle } from '../src/internal/result-bundle';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-result-bundle-test-'));
}

/** Zips the contents of root, entries at the zip root, as limulator's ditto does. */
function zipContents(root: string, zipPath: string): void {
  execFileSync('zip', ['-qry', zipPath, '.'], { cwd: root });
}

function bundleTree(): string {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Info.plist'), 'plist');
  fs.writeFileSync(path.join(root, 'Data', 'data.0~abc'), 'payload');
  return root;
}

describe('result bundle download', () => {
  test('unpacks the zip into a new .xcresult directory', async () => {
    const zip = path.join(tempDir(), 'remote.zip');
    zipContents(bundleTree(), zip);
    const destination = path.join(tempDir(), 'out', 'Tests.xcresult');

    await pullResultBundle(
      async (_remote, local) => fs.copyFileSync(zip, local),
      '/remote/run.zip',
      destination,
    );

    expect(fs.readFileSync(path.join(destination, 'Info.plist'), 'utf8')).toBe('plist');
    expect(fs.readFileSync(path.join(destination, 'Data', 'data.0~abc'), 'utf8')).toBe('payload');
    // Nothing of the staging is left beside the bundle.
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['Tests.xcresult']);
  });

  test('refuses a destination that exists, as xcodebuild does', async () => {
    const destination = tempDir();
    const pull = jest.fn();

    await expect(pullResultBundle(pull, '/remote/run.zip', destination)).rejects.toThrow('already exists');
    expect(pull).not.toHaveBeenCalled();
  });

  test('a failed download leaves no bundle behind', async () => {
    const destination = path.join(tempDir(), 'Tests.xcresult');

    await expect(
      pullResultBundle(
        async () => {
          throw new Error('connection reset');
        },
        '/remote/run.zip',
        destination,
      ),
    ).rejects.toThrow('connection reset');
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
  });

  test('refuses symlinks, even one that stays inside the bundle', async () => {
    // A chain of in-bundle links can still reach outside, so none is followed.
    for (const link of ['../../etc/passwd', 'Data/data.0~abc']) {
      const root = bundleTree();
      fs.symlinkSync(link, path.join(root, 'link'));
      const zip = path.join(tempDir(), 'remote.zip');
      zipContents(root, zip);

      await expect(extractZipToDirectory(zip, path.join(tempDir(), 'R.xcresult'))).rejects.toThrow(
        'is a symlink',
      );
    }
  });

  test('refuses an entry outside the bundle', async () => {
    const work = tempDir();
    fs.mkdirSync(path.join(work, 'inside'));
    fs.writeFileSync(path.join(work, 'outside.txt'), 'x');
    const zip = path.join(work, 'remote.zip');
    // zip keeps the ../ prefix as written, which a hostile server could send;
    // yauzl's strict names refuse it before the extractor's own check would.
    execFileSync('zip', ['-q', zip, '../outside.txt'], { cwd: path.join(work, 'inside') });

    await expect(extractZipToDirectory(zip, path.join(tempDir(), 'R.xcresult'))).rejects.toThrow(
      /invalid relative path|unsafe path/,
    );
  });
});
