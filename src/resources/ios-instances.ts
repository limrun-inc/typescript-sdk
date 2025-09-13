// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class IosInstances extends APIResource {
  /**
   * Create an iOS instance
   */
  create(params: IosInstanceCreateParams, options?: RequestOptions): APIPromise<IosInstanceCreateResponse> {
    const { wait, ...body } = params;
    return this._client.post('/v1/ios_instances', { query: { wait }, body, ...options });
  }

  /**
   * List iOS instances
   */
  list(
    query: IosInstanceListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IosInstanceListResponse> {
    return this._client.get('/v1/ios_instances', { query, ...options });
  }

  /**
   * Delete iOS instance with given name
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ios_instances/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  /**
   * Get iOS instance with given ID
   */
  get(id: string, options?: RequestOptions): APIPromise<IosInstanceGetResponse> {
    return this._client.get(path`/v1/ios_instances/${id}`, options);
  }
}

export interface IosInstanceCreateResponse {
  metadata: IosInstanceCreateResponse.Metadata;

  spec: IosInstanceCreateResponse.Spec;

  status: IosInstanceCreateResponse.Status;
}

export namespace IosInstanceCreateResponse {
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

    endpointWebSocketUrl?: string;
  }
}

export type IosInstanceListResponse = Array<IosInstanceListResponse.IosInstanceListResponseItem>;

export namespace IosInstanceListResponse {
  export interface IosInstanceListResponseItem {
    metadata: IosInstanceListResponseItem.Metadata;

    spec: IosInstanceListResponseItem.Spec;

    status: IosInstanceListResponseItem.Status;
  }

  export namespace IosInstanceListResponseItem {
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

      endpointWebSocketUrl?: string;
    }
  }
}

export interface IosInstanceGetResponse {
  metadata: IosInstanceGetResponse.Metadata;

  spec: IosInstanceGetResponse.Spec;

  status: IosInstanceGetResponse.Status;
}

export namespace IosInstanceGetResponse {
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

    endpointWebSocketUrl?: string;
  }
}

export interface IosInstanceCreateParams {
  /**
   * Query param: Return after the instance is ready to connect.
   */
  wait?: boolean;

  /**
   * Body param:
   */
  metadata?: IosInstanceCreateParams.Metadata;

  /**
   * Body param:
   */
  spec?: IosInstanceCreateParams.Spec;
}

export namespace IosInstanceCreateParams {
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

export interface IosInstanceListParams {
  /**
   * Labels filter to apply to instances to return. Expects a comma-separated list of
   * key=value pairs (e.g., env=prod,region=us-west).
   */
  labelSelector?: string;

  /**
   * Region where the instance is scheduled on.
   */
  region?: string;

  /**
   * State filter to apply to instances to return.
   */
  state?: 'unknown' | 'creating' | 'ready' | 'terminated';
}

export declare namespace IosInstances {
  export {
    type IosInstanceCreateResponse as IosInstanceCreateResponse,
    type IosInstanceListResponse as IosInstanceListResponse,
    type IosInstanceGetResponse as IosInstanceGetResponse,
    type IosInstanceCreateParams as IosInstanceCreateParams,
    type IosInstanceListParams as IosInstanceListParams,
  };
}
