import { AndroidInstances as GeneratedAndroidInstances } from './android-instances';
import { type SessionArtifact } from './session-artifacts';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export type { SessionArtifact } from './session-artifacts';

export class AndroidInstances extends GeneratedAndroidInstances {
  /**
   * List the instance's persisted session recordings.
   */
  listRecordings(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]> {
    return this._client.get(path`/v1/android_instances/${id}/recordings`, options);
  }

  /**
   * List the instance's persisted app log captures.
   */
  listAppLogs(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]> {
    return this._client.get(path`/v1/android_instances/${id}/app_logs`, options);
  }

  /**
   * List the instance's persisted event log captures.
   */
  listEvents(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]> {
    return this._client.get(path`/v1/android_instances/${id}/events`, options);
  }
}
