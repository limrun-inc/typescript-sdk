// Hand-written: the session-artifact list endpoint is not in the generated
// OpenAPI surface yet. Shared by the iOS and Android instance helpers.

/** The kind of a persisted session capture. */
export type SessionArtifactKind = 'recording' | 'appLog' | 'eventLog';

/**
 * One persisted session capture of an instance: a video recording, an app log
 * capture, or a coalesced event log. Returned by the director's
 * GET /v1/{ios,android}_instances/{id}/session_artifacts endpoint, optionally
 * narrowed with its kind query parameter.
 */
export interface SessionArtifact {
  id: string;

  kind: SessionArtifactKind;

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
