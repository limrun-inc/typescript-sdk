import type { CSSProperties } from 'react';
import type { DeviceInstallController } from '../hooks/useDeviceInstall';
import type { InstallController } from '../hooks/useInstall';
import { errorBox, hintText } from '../theme';

const panel: CSSProperties = {
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

export function ResultPanel({
  build,
  device,
}: {
  build: InstallController;
  device: DeviceInstallController;
}) {
  return (
    <>
      {build.state === 'idle' && <p style={hintText}>The detached build result will appear here.</p>}
      {build.state === 'running' && (
        <div style={{ padding: '14px', background: '#eef4ff', color: '#1a4fb3', borderRadius: '8px' }}>
          <strong>Waiting for build callback…</strong>
          <br />
          limbuild will POST the terminal result to the token-guarded webhook exposed by the backend.
        </div>
      )}
      {build.state === 'failed' && !build.status?.webhook && (
        <div style={errorBox}>{build.error ?? 'Build failed.'}</div>
      )}
      {build.status?.webhook && <pre style={panel}>{JSON.stringify(build.status.webhook, null, 2)}</pre>}
      <h2 style={{ margin: '16px 0 0', fontSize: '16px' }}>Device activity</h2>
      <div style={panel}>
        {device.activity.length === 0 ?
          'Nothing yet.'
        : device.activity
            .map((entry) => `${entry.at} ${entry.message}${entry.detail ? ` — ${entry.detail}` : ''}`)
            .join('\n')}
      </div>
    </>
  );
}
