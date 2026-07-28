// The main panel: while a publish runs it shows where the build-finish
// webhook will land and links to the build instance in the console, and once
// the webhook lands it shows how long the build took plus the payload JSON
// verbatim.
import type { CSSProperties } from 'react';
import type { PublishState } from '../hooks/usePublish';
import type { PublishStatus } from '../lib/backend';
import { errorBox, hintText, spinner } from '../theme';

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

type ResultController = {
  state: PublishState;
  status?: PublishStatus;
  error?: string;
};

export function ResultPanel({
  publish,
  webhookUrl,
}: {
  publish: ResultController;
  /** The callback URL entered in the sidebar, shown while the build runs. */
  webhookUrl: string;
}) {
  const { state, status, error } = publish;

  if (state === 'idle') {
    return <p style={hintText}>The build result will appear here once a publish runs.</p>;
  }

  if (state === 'running') {
    return (
      <div style={{ ...waitingBox, display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={spinner} />
          <span>
            Waiting for the build webhook at <code>{webhookUrl.trim()}</code>
          </span>
        </div>
        {status?.consoleUrl ?
          <a href={status.consoleUrl} target="_blank" rel="noreferrer">
            Watch the build progress in the console
          </a>
        : <span>A console link to the build instance will appear once it is up.</span>}
      </div>
    );
  }

  const webhook = status?.webhook;
  const consoleUrl = webhook?.consoleUrl ?? status?.consoleUrl;
  // Wall clock covers the whole publish (sync, build, upload, callback);
  // buildDurationMs from the payload is the build step alone.
  const wallClockMs =
    status?.webhookReceivedAt && status.startedAt ?
      Date.parse(status.webhookReceivedAt) - Date.parse(status.startedAt)
    : undefined;

  return (
    <>
      {state === 'failed' && !webhook && (
        <div style={errorBox}>
          {error ?? 'Publish failed.'}
          {consoleUrl && (
            <>
              {' '}
              <a href={consoleUrl} target="_blank" rel="noreferrer">
                Check the build instance in the console.
              </a>
            </>
          )}
        </div>
      )}
      {webhook && (
        <>
          <p style={{ ...hintText, margin: 0 }}>
            Callback received: <strong>{webhook.status ?? 'unknown status'}</strong>
            {webhook.buildDurationMs !== undefined && (
              <> — build took {formatDuration(webhook.buildDurationMs)}</>
            )}
            {wallClockMs !== undefined && <> ({formatDuration(wallClockMs)} end to end)</>}
            {consoleUrl && (
              <>
                {' · '}
                <a href={consoleUrl} target="_blank" rel="noreferrer">
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
