// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class Analytics extends APIResource {
  /**
   * Get analytics for the authenticated organization
   */
  get(
    query: AnalyticsGetParams & { from: string; to: string },
    options?: RequestOptions,
  ): APIPromise<AnalyticsResponse & { from: string; to: string }>;
  get(query: AnalyticsGetParams, options?: RequestOptions): APIPromise<AnalyticsResponse>;
  get(query: AnalyticsGetParams, options?: RequestOptions): APIPromise<AnalyticsResponse> {
    return this._client.get('/v1/analytics', { query: analyticsQuery(query), ...options });
  }

  /**
   * Returns per-instance analytics grouped by minute bucket for detailed chart
   * views.
   */
  getInstances(
    query: AnalyticsGetInstancesParams & { from: string; to: string },
    options?: RequestOptions,
  ): APIPromise<AnalyticsInstancesResponse & { from: string; to: string }>;
  getInstances(
    query: AnalyticsGetInstancesParams,
    options?: RequestOptions,
  ): APIPromise<AnalyticsInstancesResponse>;
  getInstances(
    query: AnalyticsGetInstancesParams,
    options?: RequestOptions,
  ): APIPromise<AnalyticsInstancesResponse> {
    return this._client.get('/v1/analytics/instances', { query: analyticsQuery(query), ...options });
  }
}

export interface AnalyticsInstancesResponse {
  asOf: string;

  from?: string;

  series: Array<AnalyticsInstancesResponse.Series>;

  /**
   * IANA timezone used for time bucket grouping
   */
  timezone: string;

  to?: string;
}

export namespace AnalyticsInstancesResponse {
  export interface Series {
    instances: Array<Series.Instance>;

    /**
     * RFC3339 timestamp for the start of the minute bucket in the requested timezone,
     * including the local offset
     */
    timestamp: string;
  }

  export namespace Series {
    /**
     * Analytics details for a single instance within a time bucket
     */
    export interface Instance {
      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars for this instance
       */
      cost: number;

      /**
       * Instance type ID (e.g., ios_xxx, android_xxx)
       */
      instanceTid: string;

      /**
       * Platform name.
       */
      platform: 'android' | 'ios' | 'xcode' | 'gradle';

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      billedBreakdown?: Instance.BilledBreakdown;

      /**
       * Cost breakdown by billing source in dollars
       */
      costBreakdown?: Instance.CostBreakdown;

      /**
       * Instance labels at billing time
       */
      labels?: { [key: string]: string };

      /**
       * Region where the instance ran
       */
      region?: string;
    }

    export namespace Instance {
      export interface BilledBreakdown {
        creditsBilledMinutes: number;

        onDemandBilledMinutes: number;

        /**
         * Map of plan ID to billed minutes
         */
        planBilledMinutes?: { [key: string]: number };

        /**
         * Map of subscription ID to billed minutes
         */
        subscriptionBilledMinutes?: { [key: string]: number };
      }

      /**
       * Cost breakdown by billing source in dollars
       */
      export interface CostBreakdown {
        /**
         * Cost from credits (always 0)
         */
        creditsCost: number;

        /**
         * Cost from on-demand billing in dollars
         */
        onDemandCost: number;

        /**
         * Map of plan ID to cost in dollars
         */
        planCost?: { [key: string]: number };

        /**
         * Map of subscription ID to cost in dollars
         */
        subscriptionCost?: { [key: string]: number };
      }
    }
  }
}

export interface AnalyticsResponse {
  asOf: string;

  bucket: 'hour' | 'day' | 'week' | 'minute';

  from?: string;

  series: Array<AnalyticsResponse.Series>;

  /**
   * Summary of analytics across all time buckets, broken down by platform and region
   */
  summary: AnalyticsResponse.Summary;

  /**
   * IANA timezone used for time bucket grouping
   */
  timezone: string;

  to?: string;
}

export namespace AnalyticsResponse {
  /**
   * Analytics data for a single time bucket, broken down by platform and region
   */
  export interface Series {
    /**
     * Map of region to analytics stats for Android
     */
    android: { [key: string]: Series.Android };

    /**
     * Map of region to analytics stats for Gradle
     */
    gradle: { [key: string]: Series.Gradle };

    /**
     * Map of region to analytics stats for iOS
     */
    ios: { [key: string]: Series.Ios };

    /**
     * RFC3339 timestamp for the start of the bucket in the requested timezone,
     * including the local offset
     */
    timestamp: string;

    /**
     * Map of region to analytics stats for Xcode
     */
    xcode: { [key: string]: Series.Xcode };

    /**
     * Individual instance details for this time bucket
     */
    instances?: Array<Series.Instance>;
  }

  export namespace Series {
    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Android {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Gradle {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Ios {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Xcode {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Analytics details for a single instance within a time bucket
     */
    export interface Instance {
      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars for this instance
       */
      cost: number;

      /**
       * Instance type ID (e.g., ios_xxx, android_xxx)
       */
      instanceTid: string;

      /**
       * Platform name.
       */
      platform: 'android' | 'ios' | 'xcode' | 'gradle';

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      billedBreakdown?: Instance.BilledBreakdown;

      /**
       * Cost breakdown by billing source in dollars
       */
      costBreakdown?: Instance.CostBreakdown;

      /**
       * Instance labels at billing time
       */
      labels?: { [key: string]: string };

      /**
       * Region where the instance ran
       */
      region?: string;
    }

    export namespace Instance {
      export interface BilledBreakdown {
        creditsBilledMinutes: number;

        onDemandBilledMinutes: number;

        /**
         * Map of plan ID to billed minutes
         */
        planBilledMinutes?: { [key: string]: number };

        /**
         * Map of subscription ID to billed minutes
         */
        subscriptionBilledMinutes?: { [key: string]: number };
      }

      /**
       * Cost breakdown by billing source in dollars
       */
      export interface CostBreakdown {
        /**
         * Cost from credits (always 0)
         */
        creditsCost: number;

        /**
         * Cost from on-demand billing in dollars
         */
        onDemandCost: number;

        /**
         * Map of plan ID to cost in dollars
         */
        planCost?: { [key: string]: number };

        /**
         * Map of subscription ID to cost in dollars
         */
        subscriptionCost?: { [key: string]: number };
      }
    }
  }

  /**
   * Summary of analytics across all time buckets, broken down by platform and region
   */
  export interface Summary {
    /**
     * Map of region to analytics stats for Android
     */
    android: { [key: string]: Summary.Android };

    /**
     * Map of region to analytics stats for Gradle
     */
    gradle: { [key: string]: Summary.Gradle };

    /**
     * Map of region to analytics stats for iOS
     */
    ios: { [key: string]: Summary.Ios };

    /**
     * Map of region to analytics stats for Xcode
     */
    xcode: { [key: string]: Summary.Xcode };
  }

  export namespace Summary {
    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Android {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Gradle {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Ios {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }

    /**
     * Complete analytics for a specific region including billing breakdown
     */
    export interface Xcode {
      /**
       * Average instance duration in minutes
       */
      avgDurationMinutes: number;

      /**
       * Billed minutes with platform multiplier applied
       */
      billedMinutes: number;

      /**
       * Total cost in dollars
       */
      cost: number;

      /**
       * Number of unique instances
       */
      count: number;

      /**
       * Minutes billed to credits
       */
      creditsBilledMinutes: number;

      /**
       * Cost from credits (always 0)
       */
      creditsCost: number;

      /**
       * Minutes billed on-demand
       */
      onDemandBilledMinutes: number;

      /**
       * Cost from on-demand billing in dollars
       */
      onDemandCost: number;

      /**
       * Actual runtime minutes before platform multiplier
       */
      runtimeMinutes: number;

      /**
       * Map of subscription ID to billed minutes
       */
      subscriptionBilledMinutes?: { [key: string]: number };

      /**
       * Map of subscription ID to cost in dollars
       */
      subscriptionCost?: { [key: string]: number };
    }
  }
}

/** Timestamp bounds use RFC3339 strings. All supplied bounds apply together. */
export interface AnalyticsTimeFilter {
  /** Inclusive lower bound (greater than or equal to). */
  gte?: string;
  /** Inclusive upper bound (less than or equal to). */
  lte?: string;
}

// The shared query encoder accepts primitives, so flatten these OpenAPI deepObject parameters.
function analyticsQuery(query: AnalyticsGetParams | AnalyticsGetInstancesParams): Record<string, unknown> {
  const { startedAt, stoppedAt, ...rest } = query;
  const params: Record<string, unknown> = { ...rest };
  for (const [field, bounds] of Object.entries({ startedAt, stoppedAt })) {
    if (bounds === undefined) continue;
    for (const [operator, value] of Object.entries(bounds)) {
      if (value !== undefined) params[`${field}[${operator}]`] = value;
    }
  }
  return params;
}

export interface AnalyticsGetParams {
  /** Independent start-time bounds, combined with stoppedAt and legacy from/to. */
  startedAt?: AnalyticsTimeFilter;

  /** Independent termination-time bounds. Historical entries approximate this with billing time. */
  stoppedAt?: AnalyticsTimeFilter;

  /**
   * Legacy inclusive lower bound on startedAt (RFC3339).
   */
  from?: string;

  /**
   * Legacy exclusive upper bound on startedAt (RFC3339).
   */
  to?: string;

  /**
   * Time bucket granularity for the analytics series
   */
  bucket?: 'hour' | 'day' | 'week' | 'minute';

  /**
   * Label selector to filter instances (e.g., "env=prod,team=backend")
   */
  labels?: string;

  /**
   * Optional region filter
   */
  region?: string;

  /**
   * Optional IANA timezone used for time bucket grouping. Defaults to
   * America/Los_Angeles when omitted.
   */
  timezone?: string;
}

export interface AnalyticsGetInstancesParams {
  /** Independent start-time bounds, combined with stoppedAt and legacy from/to. */
  startedAt?: AnalyticsTimeFilter;

  /** Independent termination-time bounds. Historical entries approximate this with billing time. */
  stoppedAt?: AnalyticsTimeFilter;

  /**
   * Legacy inclusive lower bound on startedAt (RFC3339).
   */
  from?: string;

  /**
   * Legacy exclusive upper bound on startedAt (RFC3339).
   */
  to?: string;

  /**
   * Label selector to filter instances (e.g., "env=prod,team=backend")
   */
  labels?: string;

  /**
   * Optional region filter
   */
  region?: string;

  /**
   * Optional IANA timezone used for minute bucket grouping. Defaults to
   * America/Los_Angeles when omitted.
   */
  timezone?: string;
}

export declare namespace Analytics {
  export {
    type AnalyticsInstancesResponse as AnalyticsInstancesResponse,
    type AnalyticsResponse as AnalyticsResponse,
    type AnalyticsTimeFilter as AnalyticsTimeFilter,
    type AnalyticsGetParams as AnalyticsGetParams,
    type AnalyticsGetInstancesParams as AnalyticsGetInstancesParams,
  };
}
