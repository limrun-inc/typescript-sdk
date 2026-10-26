import fs from 'fs';
import path from 'path';
import { downloadFileToLocalPath } from './download-file';

/** Keep an existing destination intact if the HTTP stream fails partway through. */
export async function pullBuildFile(
  apiUrl: string,
  token: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  const destination = path.resolve(localPath);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporaryDir = await fs.promises.mkdtemp(path.join(path.dirname(destination), '.lim-download-'));
  try {
    const temporaryFile = path.join(temporaryDir, 'download');
    await downloadFileToLocalPath(
      `${apiUrl.replace(/\/$/, '')}/files?path=${encodeURIComponent(remotePath)}`,
      token,
      temporaryFile,
    );
    await fs.promises.rename(temporaryFile, destination);
  } finally {
    await fs.promises.rm(temporaryDir, { recursive: true, force: true });
  }
}
