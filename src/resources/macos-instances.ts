// Hand-written following the Stainless resource pattern; a future generation
// from the OpenAPI spec reconciles with this file.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { Items, type ItemsParams, PagePromise } from '../core/pagination';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';
import {
  followMacosSnapshot,
  type MacosInstanceSnapshot,
  type MacosSnapshotConfig,
  type MacosSnapshotFollowOptions,
  type MacosSnapshotFollowResult,
} from '../macos-snapshot';

/** A macOS virtual machine, streamed to the browser like a simulator. */
export class MacosInstances extends APIResource {
  /**
   * Create a macOS instance
   */
  create(params: MacosInstanceCreateParams, options?: RequestOptions): APIPromise<MacosInstance> {
    const { reuseIfExists, wait, ...body } = params;
    return this._client.post('/v1/macos_instances', { query: { reuseIfExists, wait }, body, ...options });
  }

  /**
   * List macOS instances
   */
  list(
    query: MacosInstanceListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<MacosInstancesItems, MacosInstance> {
    return this._client.getAPIList('/v1/macos_instances', Items<MacosInstance>, { query, ...options });
  }

  /**
   * Delete macOS instance with given ID
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/macos_instances/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /** Update a live instance's labels or role using the ETag returned by get().withResponse(). */
  update(id: string, params: MacosInstanceUpdateParams, options?: RequestOptions): APIPromise<void> {
    const { ifMatch, ...body } = params;
    return this._client.patch(path`/v1/macos_instances/${id}`, {
      ...options,
      body,
      headers: buildHeaders([options?.headers, { 'If-Match': ifMatch, Accept: '*/*' }]),
    });
  }

  /**
   * Get macOS instance with given ID
   */
  get(id: string, options?: RequestOptions): APIPromise<MacosInstance> {
    return this._client.get(path`/v1/macos_instances/${id}`, options);
  }

  /** Current disk snapshot configuration and status, including a save still running at termination. */
  getSnapshot(id: string, options?: RequestOptions): APIPromise<MacosInstanceSnapshot> {
    return this._client.get(path`/v1/macos_instances/${id}/snapshot`, options);
  }

  /**
   * Set the key the instance saves under at termination. Set once: binding the same key again is
   * accepted, a different one is rejected. Works on an instance created without a snapshot.
   */
  bindSnapshotKey(id: string, key: string, options?: RequestOptions): APIPromise<MacosInstanceSnapshot> {
    return this._client.put(path`/v1/macos_instances/${id}/snapshot`, { body: { key }, ...options });
  }

  /** Follow the disk snapshot restore or save until it reaches a terminal phase. */
  followSnapshot(id: string, options?: MacosSnapshotFollowOptions): Promise<MacosSnapshotFollowResult> {
    const apiKey = this._client.apiKey;
    if (!apiKey) throw new Error('Following disk snapshot status needs an API key on the client');
    return followMacosSnapshot({ baseURL: this._client.baseURL, apiKey, instanceId: id }, options);
  }
}

export type MacosInstancesItems = Items<MacosInstance>;

export interface MacosInstance {
  metadata: MacosInstance.Metadata;

  spec: MacosInstance.Spec;

  status: MacosInstance.Status;
}

export namespace MacosInstance {
  export interface Metadata {
    id: string;

    createdAt: string;

    organizationId: string;

    displayName?: string;

    labels?: { [key: string]: string };

    /**
     * Immutable name that works like a folder path. Absent for an instance created
     * before names existed.
     */
    name?: string;

    /** Time of the controller's termination event. Physical cleanup may follow. */
    terminatedAt?: string;

    /**
     * Billing cutoff for a deletion requested while the region is unavailable.
     * Absent for normal regional deletions.
     */
    terminatingAt?: string;
  }

  export interface Spec {
    inactivityTimeout: string;

    region: string;

    /** Maximum runtime regardless of activity. */
    hardTimeout?: string;

    /** Current effective permissions. Present on live GETs; historical records may omit it. */
    role?: { permissions: string[] };
  }

  export interface Status {
    state: 'unknown' | 'creating' | 'assigned' | 'ready' | 'terminating' | 'terminated';

    apiUrl?: string;

    /** The screen-streaming WebSocket. Pass it to RemoteControl from @limrun/ui. */
    endpointWebSocketUrl?: string;

    errorMessage?: string;

    /**
     * A control token for this instance. Grants runtime access and reads, but cannot
     * create, update, or delete instance records.
     */
    token?: string;

    /**
     * A signed token that grants only streaming on this instance: it opens the
     * screen-streaming WebSocket and nothing else, so a browser can hold it while
     * `token` stays on your backend. Create, get and list return it to callers with
     * full control of the instance; get and list only while the instance runs.
     */
    streamToken?: string;

    /**
     * Machine-readable reason for instance termination. Present when state is
     * "terminating" or "terminated". New values may be added over time, so treat any
     * unrecognized value as "Unknown". Known values:
     *
     * - "UserRequested": terminated by a delete request to the API.
     * - "InactivityTimeout": the timeout given in spec.inactivityTimeout elapsed.
     * - "HardTimeout": the timeout given in spec.hardTimeout elapsed.
     * - "CapacityTimeout": no instance was free when it was created, and none freed
     *   up before its wait for capacity ended.
     * - "Unknown": terminated for a cause the platform did not attribute, including
     *   instances that failed to get ready during creation. See errorMessage for
     *   details when available.
     */
    terminationReason?: string;

    /** What happened to the instance's disk snapshot. getSnapshot() has the full status. */
    snapshot?: {
      /** The snapshot key the instance restores from. Absent when it starts cold. */
      restoreKey?: string;
      /** The save requested at termination. Absent until the instance is deleted. */
      save?: { phase: string; reason?: string; message?: string };
    };
  }
}

export interface MacosInstanceUpdateParams {
  /** Quoted ETag from a live GET. A concurrent change returns HTTP 412. */
  ifMatch: string;
  /** Replaces all customer labels. Use {} to clear them. Omission preserves labels. */
  metadata?: { labels: { [key: string]: string } };
  spec?: {
    role?: {
      /** Replaces the complete list. Use [] to remove delegated permissions. */
      permissions: string[];
    };
  };
}

export interface MacosInstanceCreateParams {
  /**
   * Query param: If there is another instance with given labels and region, return
   * that one instead of creating a new instance. Reusing it requires control
   * permission on that instance.
   */
  reuseIfExists?: boolean;

  /**
   * Query param: Return after the instance is ready to connect.
   */
  wait?: boolean;

  /**
   * Body param
   */
  metadata?: MacosInstanceCreateParams.Metadata;

  /**
   * Body param
   */
  spec?: MacosInstanceCreateParams.Spec;
}

export namespace MacosInstanceCreateParams {
  export interface Metadata {
    displayName?: string;

    labels?: { [key: string]: string };

    /**
     * Immutable name that works like a folder path, for example u/u123/preview. A
     * permission can target the name or a folder it lies in. Without one, the
     * instance is named after its ID inside the caller's default folder.
     */
    name?: string;
  }

  export interface Spec {
    /**
     * ClientLocation takes precedence over ClientIP regardless of clue order. Without
     * either clue, routing uses Cloudflare visitor coordinates, then its client IP.
     */
    clues?: Array<Spec.Clue>;

    /**
     * Maximum runtime regardless of activity. Omit to use the organization's macOS
     * default. Set to "0" to disable the hard timeout.
     */
    hardTimeout?: string;

    /**
     * After how long without input or API calls the instance is terminated, counted
     * from when it becomes ready. Example values 1m, 10m, 3h. Omitting it, or passing
     * a non-positive duration, uses the organization's macOS default.
     */
    inactivityTimeout?: string;

    /**
     * Restricts scheduling to regions in the given jurisdiction. Unlike region, this
     * is a hard constraint: the request never overflows to a region outside the
     * jurisdiction and fails when no region in the jurisdiction has capacity.
     */
    jurisdiction?: 'us' | 'eu' | 'as';

    /**
     * @deprecated A region is only a preference, not a hard pin; use jurisdiction to
     * constrain where the instance runs.
     */
    region?: string;

    /** Inline instance role. Omit for the organization's compatibility default. */
    role?: {
      /** Asset permissions delegated by the creator. An empty array grants nothing. */
      permissions: Array<string>;
    };

    /**
     * Disk snapshot to restore after assignment and save at termination. Omitted means an
     * ordinary instance that restores and saves nothing.
     */
    snapshot?: MacosSnapshotConfig;
  }

  export namespace Spec {
    export interface Clue {
      kind: 'ClientIP' | 'ClientLocation';

      clientIp?: string;

      /**
       * Required for ClientLocation. Both coordinates must be finite and within their
       * ranges. This location takes precedence over ClientIP.
       */
      clientLocation?: Clue.ClientLocation;
    }

    export namespace Clue {
      export interface ClientLocation {
        /**
         * Latitude in decimal degrees, from -90 to 90 inclusive. Zero is valid.
         */
        latitude: number;

        /**
         * Longitude in decimal degrees, from -180 to 180 inclusive. Zero is valid.
         */
        longitude: number;
      }
    }
  }
}

export interface MacosInstanceListParams extends ItemsParams {
  /**
   * Labels filter to apply to instances to return. Expects a comma-separated list of
   * key=value pairs (e.g., env=prod,region=us-west).
   */
  labelSelector?: string;

  /**
   * State filter to apply to macOS instances to return. Each comma-separated state
   * will be used as part of an OR clause, e.g. "assigned,ready" will return all
   * instances that are either assigned or ready.
   *
   * Valid states: creating, assigned, ready, terminating, terminated, unknown
   */
  state?: string;
}

export declare namespace MacosInstances {
  export {
    type MacosInstance as MacosInstance,
    type MacosInstancesItems as MacosInstancesItems,
    type MacosInstanceUpdateParams as MacosInstanceUpdateParams,
    type MacosInstanceCreateParams as MacosInstanceCreateParams,
    type MacosInstanceListParams as MacosInstanceListParams,
  };
}
