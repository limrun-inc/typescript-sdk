// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { Items, type ItemsParams, PagePromise } from '../core/pagination';
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
   * List Android instances
   */
  list(
    query: AndroidInstanceListParams | null | undefined = {},
    options?: RequestOptions,
  ): PagePromise<AndroidInstancesItems, AndroidInstance> {
    return this._client.getAPIList('/v1/android_instances', Items<AndroidInstance>, { query, ...options });
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

export type AndroidInstancesItems = Items<AndroidInstance>;

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

    state: 'unknown' | 'creating' | 'assigned' | 'ready' | 'terminated';

    adbWebSocketUrl?: string;

    endpointWebSocketUrl?: string;
  }
}

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
      kind: 'ClientIP' | 'OSVersion';

      clientIp?: string;

      /**
       * The major version of Android, e.g. "13", "14" or "15".
       */
      osVersion?: string;
    }

    export interface InitialAsset {
      kind: 'App';

      source: 'URL' | 'URLs' | 'AssetName' | 'AssetNames';

      assetName?: string;

      assetNames?: Array<string>;

      url?: string;

      urls?: Array<string>;
    }
  }
}

export interface AndroidInstanceListParams extends ItemsParams {
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
   * State filter to apply to Android instances to return. Each comma-separated state
   * will be used as part of an OR clause, e.g. "assigned,ready" will return all
   * instances that are either assigned or ready.
   */
  state?: string;
}

export declare namespace AndroidInstances {
  export {
    type AndroidInstance as AndroidInstance,
    type AndroidInstancesItems as AndroidInstancesItems,
    type AndroidInstanceCreateParams as AndroidInstanceCreateParams,
    type AndroidInstanceListParams as AndroidInstanceListParams,
  };
}
