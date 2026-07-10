import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { nodeProxyTransport } from './proxy-transport';

export async function downloadFileToLocalPath(
  url: string,
  token: string,
  localPath: string,
  onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await nodeProxyTransport.fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const errorBody = await response.text();
      const isRetriable = response.status >= 500 && response.status < 600;
      if (isRetriable && attempt < maxRetries) {
        continue;
      }
      throw new Error(`Download failed: ${response.status} ${errorBody}`);
    }
    if (!response.body) {
      throw new Error('Download failed: response body is missing');
    }
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    const source = Readable.fromWeb(response.body as any);
    if (onProgress) {
      const totalBytes = Number(response.headers.get('content-length') ?? 0);
      let downloadedBytes = 0;
      source.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        onProgress(downloadedBytes, totalBytes);
      });
    }
    await pipeline(source, fs.createWriteStream(localPath));
    return;
  }
}
