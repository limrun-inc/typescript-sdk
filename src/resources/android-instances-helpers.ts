import { RequestOptions } from '../internal/request-options';
import {
  AndroidInstance,
  AndroidInstanceCreateParams,
  AndroidInstances as GeneratedAndroidInstances,
} from './android-instances';

export class AndroidInstances extends GeneratedAndroidInstances {
  async getOrCreate(params: AndroidInstanceCreateParams, options?: RequestOptions): Promise<AndroidInstance> {
    if (!params.metadata || !params.metadata.labels || Object.keys(params.metadata.labels).length === 0) {
      return Promise.reject(new Error('At least one label is required for getOrCreate operation'));
    }
    const instances = await super.list(
      {
        labelSelector: Object.entries(params.metadata.labels)
          .map(([key, value]) => `${key}=${value}`)
          .join(','),
        state: 'ready',
      },
      options,
    );
    if (instances && instances.length > 0) {
      return instances[0]!;
    }
    return super.create(params, options);
  }
}
