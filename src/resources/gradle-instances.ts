// Hand-written following the Stainless resource pattern; a future generation
// from the OpenAPI spec reconciles with this file.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { Items, type ItemsParams, PagePromise } from '../core/pagination';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class GradleInstances extends APIResource {
  /**
   * Create a gradle instance
   */
  create(params: GradleInstanceCreateParams, options?: RequestOptions): APIPromise<GradleInstance> {
    const { reuseIfExists, wait, ...body } = params;
    return this._client.post('/v1/gradle_instances', { query: { reuseIfExists, wait }, body, ...options });
  }

  /**
   * List gradle instances
   */
  list(
    query: GradleInstanceListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<GradleInstancesItems, GradleInstance> {
    return this._client.getAPIList('/v1/gradle_instances', Items<GradleInstance>, { query, ...options });
  }

  /**
   * Delete gradle instance with given name
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/gradle_instances/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Get gradle instance with given ID
   */
  get(id: string, options?: RequestOptions): APIPromise<GradleInstance> {
    return this._client.get(path`/v1/gradle_instances/${id}`, options);
  }
}

export type GradleInstancesItems = Items<GradleInstance>;

export interface GradleInstance {
  metadata: GradleInstance.Metadata;

  spec: GradleInstance.Spec;

  status: GradleInstance.Status;
}

export namespace GradleInstance {
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

export interface GradleInstanceCreateParams {
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
  metadata?: GradleInstanceCreateParams.Metadata;

  /**
   * Body param
   */
  spec?: GradleInstanceCreateParams.Spec;
}

export namespace GradleInstanceCreateParams {
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
     * After how many minutes of inactivity should the instance be terminated. Example
     * values 1m, 10m, 3h. Default is 5m.
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

export interface GradleInstanceListParams extends ItemsParams {
  /**
   * Labels filter to apply to instances to return. Expects a comma-separated list of
   * key=value pairs (e.g., env=prod,region=us-west).
   */
  labelSelector?: string;

  /**
   * State filter to apply to gradle instances to return. Each comma-separated state
   * will be used as part of an OR clause, e.g. "assigned,ready" will return all
   * instances that are either assigned or ready.
   *
   * Valid states: creating, assigned, ready, terminated, unknown
   */
  state?: string;
}

export declare namespace GradleInstances {
  export {
    type GradleInstance as GradleInstance,
    type GradleInstancesItems as GradleInstancesItems,
    type GradleInstanceCreateParams as GradleInstanceCreateParams,
    type GradleInstanceListParams as GradleInstanceListParams,
  };
}
