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
      body: data,
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
