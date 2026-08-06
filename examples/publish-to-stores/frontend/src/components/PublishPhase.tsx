// The Publish phase: one App Store Connect upload with distribution signing
// and a detached webhook-backed build. The uploaded build serves TestFlight
// and App Store review alike; where it goes next is decided in App Store
// Connect.
import { useState } from 'react';
import type { ConnectController } from '../hooks/useConnect';
import type { PublishController } from '../hooks/usePublish';
import { errorBox, hintText, infoBox, inputStyle, labelStyle, primaryButton } from '../theme';
import { Section } from './Section';

function appStoreConnectUrl(ascAppId?: string) {
  if (!ascAppId) return 'https://appstoreconnect.apple.com/apps';
  return `https://appstoreconnect.apple.com/apps/${ascAppId}/distribution`;
}

export function PublishPhase({
  connect,
  publish,
  webhookUrl,
}: {
  connect: ConnectController;
  publish: PublishController;
  /** The sidebar's webhook URL; rides the publish request. Empty blocks publishing. */
  webhookUrl: string;
}) {
  const [projectPath, setProjectPath] = useState('');

  if (!connect.publishReady || !connect.connection) {
    return (
      <Section title="2. Publish">
        <p style={hintText}>Locked. Complete the Connect phase first.</p>
      </Section>
    );
  }

  const { connection } = connect;
  const running = publish.state === 'running';
  const webhookUrlSet = webhookUrl.trim() !== '';
  const canPublish = !running && projectPath.trim() !== '' && webhookUrlSet;

  return (
    <Section title="2. Publish">
      <label style={labelStyle}>Project path (on the backend host)</label>
      <input
        style={inputStyle}
        value={projectPath}
        onChange={(event) => setProjectPath(event.target.value)}
        placeholder="/path/to/MyApp"
      />
      {!projectPath.trim() && <p style={hintText}>Enter the project path to enable publishing.</p>}
      {!webhookUrlSet && (
        <p style={hintText}>Enter the webhook URL at the top of the sidebar to enable publishing.</p>
      )}
      <button
        style={primaryButton(!canPublish)}
        disabled={!canPublish}
        onClick={() =>
          void publish.publish({
            projectPath: projectPath.trim(),
            teamId: connection.teamId,
            bundleId: connection.bundleId,
            signingMode: connection.signingMode,
            webhookUrl: webhookUrl.trim(),
          })
        }
      >
        {running ? 'Waiting for build callback…' : 'Submit to App Store'}
      </button>
      {publish.state === 'succeeded' && (
        <div style={infoBox}>
          Publish succeeded.{' '}
          <a href={appStoreConnectUrl(connection.ascAppId)} target="_blank" rel="noreferrer">
            Open the app in App Store Connect
          </a>{' '}
          to attach the processed build to a version and submit it for review; TestFlight picks the build up
          automatically.
        </div>
      )}
      {publish.state === 'failed' && (
        <div style={errorBox}>Publish failed{publish.error ? `: ${publish.error}` : '.'}</div>
      )}
    </Section>
  );
}
