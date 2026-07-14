// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { Items, type ItemsParams, PagePromise } from '../core/pagination';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class XcodeInstances extends APIResource {
  /**
   * Create an Xcode instance
   */
  create(params: XcodeInstanceCreateParams, options?: RequestOptions): APIPromise<XcodeInstance> {
    const { reuseIfExists, wait, ...body } = params;
    return this._client.post('/v1/xcode_instances', { query: { reuseIfExists, wait }, body, ...options });
  }

  /**
   * List Xcode instances
   */
  list(
    query: XcodeInstanceListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<XcodeInstancesItems, XcodeInstance> {
    return this._client.getAPIList('/v1/xcode_instances', Items<XcodeInstance>, { query, ...options });
  }

  /**
   * Delete Xcode instance with given name
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/xcode_instances/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Get Xcode instance with given ID
   */
  get(id: string, options?: RequestOptions): APIPromise<XcodeInstance> {
    return this._client.get(path`/v1/xcode_instances/${id}`, options);
  }
}

export type XcodeInstancesItems = Items<XcodeInstance>;

export interface XcodeInstance {
  metadata: XcodeInstance.Metadata;

  spec: XcodeInstance.Spec;

  status: XcodeInstance.Status;
}

export namespace XcodeInstance {
  export interface Metadata {
    id: string;

    createdAt: string;

    organizationId: string;

    displayName?: string;

    labels?: { [key: string]: string };

    terminatedAt?: string;
  }

  export interface Spec {
    inactivityTimeout: string;

    region: string;

    hardTimeout?: string;
  }

  export interface Status {
    token: string;

    state: 'unknown' | 'creating' | 'assigned' | 'ready' | 'terminated';

    apiUrl?: string;

    errorMessage?: string;

    /**
     * Machine-readable reason the instance was terminated. Always present once state
     * is "terminated", never present before that. New values may be added over time,
     * so treat any unrecognized value as "Unknown". Known values:
     *
     * - "UserRequested": terminated by a delete request to the API.
     * - "InactivityTimeout": the timeout given in spec.inactivityTimeout elapsed.
     * - "HardTimeout": the timeout given in spec.hardTimeout elapsed.
     * - "Unknown": terminated for a cause the platform did not attribute, including
     *   instances that failed to get ready during creation. See errorMessage for
     *   details when available.
     */
    terminationReason?: string;
  }
}

export interface XcodeInstanceCreateParams {
  /**
   * Query param: If there is another instance with given labels and region, return
   * that one instead of creating a new instance.
   */
  reuseIfExists?: boolean;

  /**
   * Query param: Return after the instance is ready to connect.
   */
  wait?: boolean;

  /**
   * Body param
   */
  metadata?: XcodeInstanceCreateParams.Metadata;

  /**
   * Body param
   */
  spec?: XcodeInstanceCreateParams.Spec;
}

export namespace XcodeInstanceCreateParams {
  export interface Metadata {
    displayName?: string;

    labels?: { [key: string]: string };
  }

  export interface Spec {
    clues?: Array<Spec.Clue>;

    /**
     * After how many minutes should the instance be terminated. Example values 1m,
     * 10m, 3h. Default is "0" which means no hard timeout.
     */
    hardTimeout?: string;

    /**
     * After how many minutes of inactivity should the instance be terminated. The
     * timer starts once the instance becomes ready. Example values 1m, 10m, 3h.
     * Default is 5m. Providing "0" uses the organization's default inactivity timeout.
     */
    inactivityTimeout?: string;

    /**
     * Where the instance will be created. If not given, the region is decided based on
     * scheduling clues (client IP) and availability.
     *
     * A region is a preference, not a hard pin: the request always overflows to every
     * other available region, ordered by proximity, when the preferred ones are full.
     *
     * Accepted values:
     *
     * - A specific region name (e.g. "us-west1"). It is tried first, then the
     *   remaining regions in order of proximity to it. Scheduling clues (client IP)
     *   are ignored when a region is given.
     * - A region group name (e.g. "us", "eu"). Its member regions are tried first in
     *   their listed order, then the remaining regions by proximity to the first
     *   member.
     * - A pipe-separated, ordered list of regions (e.g. "us-east1|us-west1"). Those
     *   are tried first in the given order, then the remaining regions by proximity to
     *   the first.
     */
    region?: string;
  }

  export namespace Spec {
    export interface Clue {
      kind: 'ClientIP';

      clientIp?: string;
    }
  }
}

export interface XcodeInstanceListParams extends ItemsParams {
  /**
   * Labels filter to apply to instances to return. Expects a comma-separated list of
   * key=value pairs (e.g., env=prod,region=us-west).
   */
  labelSelector?: string;

  /**
   * State filter to apply to Xcode instances to return. Each comma-separated state
   * will be used as part of an OR clause, e.g. "assigned,ready" will return all
   * instances that are either assigned or ready.
   *
   * Valid states: creating, assigned, ready, terminated, unknown
   */
  state?: string;
}

export declare namespace XcodeInstances {
  export {
    type XcodeInstance as XcodeInstance,
    type XcodeInstancesItems as XcodeInstancesItems,
    type XcodeInstanceCreateParams as XcodeInstanceCreateParams,
    type XcodeInstanceListParams as XcodeInstanceListParams,
  };
}
