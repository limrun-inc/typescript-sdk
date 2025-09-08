// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class AndroidInstances extends APIResource {
  /**
   * Create an Android instance
   */
  create(params: AndroidInstanceCreateParams, options?: RequestOptions): APIPromise<AndroidInstance> {
    const { wait, ...body } = params;
    return this._client.post('/v1/android_instances', { query: { wait }, body, ...options });
  }

  /**
   * List Android instances belonging to given organization
   */
  list(
    query: AndroidInstanceListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<AndroidInstanceListResponse> {
    return this._client.get('/v1/android_instances', { query, ...options });
  }

  /**
   * Delete Android instance with given name
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/android_instances/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Get Android instance with given ID
   */
  get(id: string, options?: RequestOptions): APIPromise<AndroidInstance> {
    return this._client.get(path`/v1/android_instances/${id}`, options);
  }
}

export interface AndroidInstance {
  metadata: AndroidInstance.Metadata;

  spec: AndroidInstance.Spec;

  status: AndroidInstance.Status;
}

export namespace AndroidInstance {
  export interface Metadata {
    id: string;

    createdAt: string;

    organizationId: string;

    displayName?: string;

    labels?: { [key: string]: string };

    terminatedAt?: string;
  }

  export interface Spec {
    /**
     * After how many minutes of inactivity should the instance be terminated. Example
     * values 1m, 10m, 3h. Default is 3m. Providing "0" disables inactivity checks
     * altogether.
     */
    inactivityTimeout: string;

    /**
     * The region where the instance will be created. If not given, will be decided
     * based on scheduling clues and availability.
     */
    region: string;

    /**
     * After how many minutes should the instance be terminated. Example values 1m,
     * 10m, 3h. Default is "0" which means no hard timeout.
     */
    hardTimeout?: string;
  }

  export interface Status {
    token: string;

    state: 'unknown' | 'creating' | 'ready' | 'terminated';

    adbWebSocketUrl?: string;

    endpointWebSocketUrl?: string;
  }
}

export type AndroidInstanceListResponse = Array<AndroidInstance>;

export interface AndroidInstanceCreateParams {
  /**
   * Query param: Return after the instance is ready to connect.
   */
  wait?: boolean;

  /**
   * Body param:
   */
  metadata?: AndroidInstanceCreateParams.Metadata;

  /**
   * Body param:
   */
  spec?: AndroidInstanceCreateParams.Spec;
}

export namespace AndroidInstanceCreateParams {
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
     * values 1m, 10m, 3h. Default is 3m. Providing "0" disables inactivity checks
     * altogether.
     */
    inactivityTimeout?: string;

    initialAssets?: Array<Spec.InitialAsset>;

    /**
     * The region where the instance will be created. If not given, will be decided
     * based on scheduling clues and availability.
     */
    region?: string;
  }

  export namespace Spec {
    export interface Clue {
      kind: 'ClientIP';

      clientIp?: string;
    }

    export interface InitialAsset {
      kind: 'App';

      source: 'URL' | 'AssetName';

      assetName?: string;

      url?: string;
    }
  }
}

export interface AndroidInstanceListParams {
  /**
   * Labels filter to apply to Android instances to return. Expects a comma-separated
   * list of key=value pairs (e.g., env=prod,region=us-west).
   */
  labelSelector?: string;

  /**
   * Region where the instance is scheduled on.
   */
  region?: string;

  /**
   * State filter to apply to Android instances to return.
   */
  state?: 'unknown' | 'creating' | 'ready' | 'terminated';
}

export declare namespace AndroidInstances {
  export {
    type AndroidInstance as AndroidInstance,
    type AndroidInstanceListResponse as AndroidInstanceListResponse,
    type AndroidInstanceCreateParams as AndroidInstanceCreateParams,
    type AndroidInstanceListParams as AndroidInstanceListParams,
  };
}
