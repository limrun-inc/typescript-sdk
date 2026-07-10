import { basename } from 'path';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';

import { RequestOptions } from '../internal/request-options';
import { nodeProxyTransport } from '../internal/proxy-transport';
import { Assets as GeneratedAssets, type AssetKind, type AssetPlatform } from './assets';

export interface AssetGetOrUploadParams {
  /**
   * The path to the file to upload.
   */
  path: string;

  /**
   * The name for the asset. Defaults to the name of the file given in the filePath parameter.
   */
  name?: string;

  /**
   * Optional time-to-live as a Go duration string (e.g. "24h"). When set, the asset is deleted
   * this long after now; minimum is 1m. Omit for no expiry. On re-upload of an existing asset,
   * a value updates the expiry while omitting it leaves the current expiry unchanged.
   */
  ttl?: string;

  /**
   * Asset kind. Defaults to App for file uploads.
   */
  kind?: Extract<AssetKind, 'App'>;

  /**
   * Optional platform for the asset.
   */
  platform?: AssetPlatform;

  /**
   * Optional callback fired as upload bytes are handed to the network, for progress
   * reporting. Not called when the server already has identical content (md5 match)
   * and the upload is skipped.
   */
  onUploadProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface AssetGetOrUploadResponse {
  id: string;
  name: string;
  signedDownloadUrl: string;
  kind: AssetKind;
  platform?: AssetPlatform;
  md5: string;
  expiresAt?: string;
}

/**
 * Body init for the signed-URL PUT. Without a progress callback the buffer is sent
 * directly. With one, the buffer is wrapped in a ReadableStream so the callback can
 * fire as chunks are pulled onto the socket; the explicit Content-Length header set
 * by the caller keeps the request non-chunked, which signed URLs require.
 */
function uploadBodyInit(
  data: Buffer,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): { body: NonNullable<RequestInit['body']>; duplex?: 'half' } {
  if (!onProgress) {
    return { body: data as unknown as NonNullable<RequestInit['body']> };
  }
  const chunkSize = 256 * 1024;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= data.length) {
        controller.close();
        return;
      }
      const chunk = data.subarray(sent, Math.min(sent + chunkSize, data.length));
      sent += chunk.length;
      controller.enqueue(chunk);
      onProgress(sent, data.length);
    },
  });
  return { body: stream as unknown as NonNullable<RequestInit['body']>, duplex: 'half' };
}

export class Assets extends GeneratedAssets {
  async getOrUpload(
    body: AssetGetOrUploadParams,
    options?: RequestOptions,
  ): Promise<AssetGetOrUploadResponse> {
    const creationResponse = await this.getOrCreate(
      {
        name: body.name ?? basename(body.path),
        kind: body.kind ?? 'App',
        ...(body.platform && { platform: body.platform }),
        ...(body.ttl && { ttl: body.ttl }),
      },
      options,
    );
    const data = await fs.readFile(body.path);
    const md5 = createHash('md5').update(data).digest('hex');
    if (creationResponse.md5 && creationResponse.md5 === md5) {
      return {
        id: creationResponse.id,
        name: creationResponse.name,
        signedDownloadUrl: creationResponse.signedDownloadUrl,
        kind: creationResponse.kind,
        ...(creationResponse.platform && { platform: creationResponse.platform }),
        md5: creationResponse.md5,
        ...(creationResponse.expiresAt && { expiresAt: creationResponse.expiresAt }),
      };
    }
    const uploadResponse = await nodeProxyTransport.fetch(creationResponse.signedUploadUrl, {
      headers: {
        'Content-Length': data.length.toString(),
        'Content-Type': 'application/octet-stream',
      },
      method: 'PUT',
      ...uploadBodyInit(data, body.onUploadProgress),
    });
    if (uploadResponse.status !== 200) {
      throw new Error(`Failed to upload asset: ${uploadResponse.status} ${await uploadResponse.text()}`);
    }
    return {
      id: creationResponse.id,
      name: creationResponse.name,
      signedDownloadUrl: creationResponse.signedDownloadUrl,
      kind: creationResponse.kind,
      ...(creationResponse.platform && { platform: creationResponse.platform }),
      md5,
      ...(creationResponse.expiresAt && { expiresAt: creationResponse.expiresAt }),
    };
  }
}
