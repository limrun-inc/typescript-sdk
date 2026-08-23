// Hand-written: the session-artifact list endpoints are not in the generated
// OpenAPI surface yet. Shared by the iOS and Android instance helpers.

/**
 * One persisted session capture of an instance: a video recording, an app log
 * capture, or a coalesced event log. Returned by the director's
 * GET /v1/{ios,android}_instances/{id}/{recordings,app_logs,events} endpoints.
 */
export interface SessionArtifact {
  id: string;

  kind: 'recording' | 'appLog' | 'eventLog';

  /** Bundle id (iOS) or package name (Android) for app log captures. */
  bundleId?: string;

  startedAt?: string;

  stoppedAt?: string;

  /** When the artifact is deleted from storage. */
  expiresAt?: string;

  sizeBytes?: number;

  /**
   * Short-lived presigned GET URL for the raw artifact: MP4 for recordings,
   * JSONL for app logs and event logs.
   */
  downloadUrl: string;
}
