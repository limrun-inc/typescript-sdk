import { IosInstances as GeneratedIosInstances } from './ios-instances';
import { type SessionArtifact, type SessionArtifactKind } from './session-artifacts';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export type { SessionArtifact, SessionArtifactKind } from './session-artifacts';

export class IosInstances extends GeneratedIosInstances {
  /**
   * List the instance's persisted session artifacts, optionally narrowed to
   * one kind.
   */
  listSessionArtifacts(
    id: string,
    kind?: SessionArtifactKind,
    options?: RequestOptions,
  ): APIPromise<SessionArtifact[]> {
    return this._client.get(path`/v1/ios_instances/${id}/session_artifacts`, {
      query: kind ? { kind } : undefined,
      ...options,
    });
  }

  /**
   * List the instance's persisted session recordings.
   */
  listRecordings(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]> {
    return this.listSessionArtifacts(id, 'recording', options);
  }

  /**
   * List the instance's persisted app log captures.
   */
  listAppLogs(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]> {
    return this.listSessionArtifacts(id, 'appLog', options);
  }

  /**
   * List the instance's persisted event log captures.
   */
  listEvents(id: string, options?: RequestOptions): APIPromise<SessionArtifact[]> {
    return this.listSessionArtifacts(id, 'eventLog', options);
  }
}
