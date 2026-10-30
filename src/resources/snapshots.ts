import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export interface SnapshotListParams {
  /** Literal key prefix. Omit to list all keys. */
  prefix?: string;
  /** Page size: 1–500 for Xcode, 1–100 for iOS. */
  limit?: number;
  offset?: number;
}

export interface SnapshotList<Snapshot> {
  snapshots: Snapshot[];
  /** Pass as offset to read the next page. Absent on the last page. */
  nextOffset?: number;
}

export interface XcodeSnapshot {
  key: string;
  directoryKey: string;
  rootName: string;
  paths?: string[];
  xcodeVersionKey: string;
  archiveFormat: string;
  archiveSizeBytes: number;
  sha256: string;
  publishedAt: string;
  sourceInstanceId?: string;
}

export interface IOSSnapshot {
  key: string;
  saved: boolean;
  createdAt: string;
  lastUsedAt: string;
  archiveSizeBytes?: number;
  publishedAt?: string;
  iosVersion?: string;
}

export class XcodeSnapshots extends APIResource {
  /** List saved workspaces, newest publication first. */
  list(
    organizationId: string,
    query: SnapshotListParams = {},
    options?: RequestOptions,
  ): APIPromise<SnapshotList<XcodeSnapshot>> {
    return this._client.get(path`/v1/organizations/${organizationId}/xcode_snapshots`, { query, ...options });
  }

  get(organizationId: string, key: string, options?: RequestOptions): APIPromise<XcodeSnapshot> {
    return this._client.get(path`/v1/organizations/${organizationId}/xcode_snapshots/${key}`, options);
  }

  /** Delete the archive and index entry. Running instances can publish this key again. */
  delete(organizationId: string, key: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/organizations/${organizationId}/xcode_snapshots/${key}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export class IOSSnapshots extends APIResource {
  /** List simulator snapshot keys alphabetically, including keys not saved yet. */
  list(
    organizationId: string,
    query: SnapshotListParams = {},
    options?: RequestOptions,
  ): APIPromise<SnapshotList<IOSSnapshot>> {
    return this._client.get(path`/v1/organizations/${organizationId}/ios_snapshots`, { query, ...options });
  }

  get(organizationId: string, key: string, options?: RequestOptions): APIPromise<IOSSnapshot> {
    return this._client.get(path`/v1/organizations/${organizationId}/ios_snapshots/${key}`, options);
  }

  /** Delete saved apps, data and the index entry. Running simulators can save this key again. */
  delete(organizationId: string, key: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/organizations/${organizationId}/ios_snapshots/${key}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}
