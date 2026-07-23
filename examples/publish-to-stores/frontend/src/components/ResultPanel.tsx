// The main panel: while a publish runs it waits for the build-finish
// webhook, and once that lands it shows how long the build took plus the
// payload JSON verbatim. There is no live log — the persisted build log is
// linked from the payload's logsUrl instead.
import type { CSSProperties } from 'react';
import type { PublishController } from '../hooks/usePublish';
import { errorBox, hintText } from '../theme';

const jsonPanel: CSSProperties = {
  overflowY: 'auto',
  padding: '12px',
  backgroundColor: '#0d1117',
  color: '#c9d1d9',
  borderRadius: '8px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
};

const waitingBox: CSSProperties = {
  padding: '14px',
  backgroundColor: '#eef4ff',
  color: '#1a4fb3',
  borderRadius: '8px',
  fontSize: '13px',
  lineHeight: 1.6,
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function ResultPanel({ publish }: { publish: PublishController }) {
  const { state, status, error } = publish;

  if (state === 'idle') {
    return <p style={hintText}>The build result will appear here once a publish runs.</p>;
  }

  if (state === 'running') {
    return (
      <div style={waitingBox}>
        <strong>Waiting for build callback…</strong>
        <br />
        The build is running remotely. When it finishes, limbuild POSTs a webhook to this backend (through the
        tunnel) and the payload shows up here. The CLI detached after submitting the build, so it does not
        hold this backend request open.
      </div>
    );
  }

  const webhook = status?.webhook;
  // Wall clock covers the whole publish (sync, build, upload, callback);
  // buildDurationMs from the payload is the build step alone.
  const wallClockMs =
    status?.webhookReceivedAt && status.startedAt ?
      Date.parse(status.webhookReceivedAt) - Date.parse(status.startedAt)
    : undefined;

  return (
    <>
      {state === 'failed' && !webhook && <div style={errorBox}>{error ?? 'Publish failed.'}</div>}
      {webhook && (
        <>
          <p style={{ ...hintText, margin: 0 }}>
            Callback received: <strong>{webhook.status ?? 'unknown status'}</strong>
            {webhook.buildDurationMs !== undefined && (
              <> — build took {formatDuration(webhook.buildDurationMs)}</>
            )}
            {wallClockMs !== undefined && <> ({formatDuration(wallClockMs)} end to end)</>}
            {webhook.consoleUrl && (
              <>
                {' · '}
                <a href={webhook.consoleUrl} target="_blank" rel="noreferrer">
                  Console
                </a>
              </>
            )}
            {webhook.logsUrl && (
              <>
                {' · '}
                <a href={webhook.logsUrl} target="_blank" rel="noreferrer">
                  Build log
                </a>
              </>
            )}
          </p>
          <pre style={jsonPanel}>{JSON.stringify(webhook, null, 2)}</pre>
        </>
      )}
    </>
  );
}
