/** Persisted capture kinds returned by instance session-artifact listings. */
export type SessionArtifactKind = 'recording' | 'appLog' | 'eventLog' | 'networkLog';

/** Metadata and download URL for one persisted instance-session capture. */
export interface SessionArtifact {
  id: string;
  kind: SessionArtifactKind;
  downloadUrl: string;
  bundleId?: string;
  /** Destination tunnel that produced a networkLog artifact. */
  tunnelId?: string;
  /** Canonical selectors captured by a networkLog artifact. */
  selectors?: string[];
  startedAt?: string;
  stoppedAt?: string;
  expiresAt?: string;
  sizeBytes?: number;
}

export interface SessionArtifactListParams {
  /** Return only artifacts of this kind. */
  kind?: SessionArtifactKind;
}
