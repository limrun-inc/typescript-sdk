import fs from 'fs';
import path from 'path';
import { extractZipToDirectory } from '../app-archive';

/**
 * Downloads a run's zipped result bundle and unpacks it at localPath as an
 * `.xcresult` directory. Like xcodebuild, it refuses a path that already
 * exists. The bundle is unpacked beside its destination and moved into place
 * last, so a failed download never leaves half a bundle there.
 */
export async function pullResultBundle(
  pull: (remotePath: string, localPath: string) => Promise<void>,
  remotePath: string,
  localPath: string,
): Promise<void> {
  const destination = path.resolve(localPath);
  if (fs.existsSync(destination)) {
    throw new Error(`${localPath} already exists; choose a new result bundle path`);
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.lim-xcresult-'));
  try {
    const zip = path.join(staging, 'bundle.zip');
    await pull(remotePath, zip);
    const bundle = path.join(staging, 'bundle.xcresult');
    await extractZipToDirectory(zip, bundle);
    await fs.promises.rename(bundle, destination);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}
