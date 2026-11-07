import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { savePrivateFiles } from './store-output';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  open: jest.fn(jest.requireActual('node:fs/promises').open),
}));
const realOpen: typeof open = jest.requireActual('node:fs/promises').open;
let directory: string;
let files: string[];
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lim-private-export-'));
  files = [path.join(directory, 'key.p12'), path.join(directory, 'credentials.json')];
  jest.mocked(open).mockImplementation(realOpen);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each([0, 1])('cleans both outputs after write %i fails and permits retry', async (failedIndex) => {
  jest.mocked(open).mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (args[0] === files[failedIndex]) {
      const write = handle.writeFile.bind(handle);
      jest.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await write('partial');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
    }
    return handle;
  });
  const contents = async () => ['private key', 'credentials'];
  await expect(savePrivateFiles(files, contents)).rejects.toThrow('disk full');
  for (const file of files) await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  jest.mocked(open).mockImplementation(realOpen);
  await savePrivateFiles(files, contents);
  expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(await contents());
  if (process.platform !== 'win32') {
    for (const file of files) expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
});

test('preserves an existing second destination and never generates or writes new contents', async () => {
  await writeFile(files[1]!, 'existing');
  const contents = jest.fn(async () => ['key', 'credentials']);
  await expect(savePrivateFiles(files, contents)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(contents).not.toHaveBeenCalled();
  await expect(stat(files[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(files[1]!, 'utf8')).toBe('existing');
});

test('cleans reservations when key generation fails', async () => {
  await expect(
    savePrivateFiles(files, async () => {
      throw new Error('generation failed');
    }),
  ).rejects.toThrow('generation failed');
  for (const file of files) await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});
