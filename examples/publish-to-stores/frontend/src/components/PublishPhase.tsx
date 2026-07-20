// The Publish phase UI: project path, method cards, and the publish
// trigger. Unlocked once Connect has stored the distribution certificate,
// App Store profile, and App Store Connect API key.
import { useState } from 'react';
import type { ConnectController } from '../hooks/useConnect';
import type { PublishController } from '../hooks/usePublish';
import type { PublishMethod } from '../lib/backend';
import { errorBox, hintText, infoBox, inputStyle, labelStyle, methodCard, primaryButton } from '../theme';
import { Section } from './Section';

type MethodCardSpec = {
  id: PublishMethod | 'webusb' | 'qr';
  label: string;
  description: string;
  enabled: boolean;
};

/**
 * The App Store Connect page a finished upload lands on. With the app
 * record ID (captured during Connect) this deep-links into the app's
 * TestFlight builds or App Store version page; without it, the apps list.
 */
function appStoreConnectUrl(method: PublishMethod, ascAppId?: string) {
  if (!ascAppId) return 'https://appstoreconnect.apple.com/apps';
  return method === 'testflight' ?
      `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/ios`
    : `https://appstoreconnect.apple.com/apps/${ascAppId}/distribution`;
}

const METHODS: MethodCardSpec[] = [
  {
    id: 'testflight',
    label: 'TestFlight',
    description: 'Upload the build and distribute it to testers.',
    enabled: true,
  },
  {
    id: 'appstore',
    label: 'App Store',
    description: 'Same upload; submit the processed build for review in App Store Connect.',
    enabled: true,
  },
  {
    id: 'webusb',
    label: 'WebUSB',
    description: 'Install to a connected device. Next iteration.',
    enabled: false,
  },
  { id: 'qr', label: 'QR code', description: 'Ad-hoc install via QR. Next iteration.', enabled: false },
];

export function PublishPhase({
  connect,
  publish,
}: {
  connect: ConnectController;
  publish: PublishController;
}) {
  // The project path only matters once a publish is triggered — the CLI
  // reads the project from the backend host's filesystem. Connect never
  // touches it, so it lives here rather than above the wizard.
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
  const canPublish = !running && projectPath.trim() !== '';

  return (
    <Section title="2. Publish">
      <label style={labelStyle}>Project path (on the backend host)</label>
      <input
        style={inputStyle}
        value={projectPath}
        onChange={(event) => setProjectPath(event.target.value)}
        placeholder="/path/to/MyApp"
      />
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {METHODS.map((spec) => (
          <button
            key={spec.id}
            style={methodCard(publish.method === spec.id, !spec.enabled)}
            disabled={!spec.enabled || running}
            onClick={() => publish.setMethod(spec.id as PublishMethod)}
          >
            <strong>{spec.label}</strong>
            <br />
            <span style={hintText}>{spec.description}</span>
          </button>
        ))}
      </div>
      {!projectPath.trim() && <p style={hintText}>Enter the project path to enable publishing.</p>}
      <button
        style={primaryButton(!canPublish)}
        disabled={!canPublish}
        onClick={() =>
          void publish.publish({
            projectPath: projectPath.trim(),
            method: publish.method,
            teamId: connection.teamId,
            bundleId: connection.bundleId,
          })
        }
      >
        {running ? 'Publishing…' : `Publish ${connection.bundleId} via ${publish.method}`}
      </button>
      {publish.state === 'succeeded' && (
        <div style={infoBox}>
          Publish succeeded.{' '}
          {publish.method === 'appstore' ?
            <>
              <a href={appStoreConnectUrl('appstore', connection.ascAppId)} target="_blank" rel="noreferrer">
                Open the App Store page in App Store Connect
              </a>{' '}
              to attach the processed build to a version and submit it for review.
            </>
          : <>
              <a
                href={appStoreConnectUrl('testflight', connection.ascAppId)}
                target="_blank"
                rel="noreferrer"
              >
                Open the TestFlight page in App Store Connect
              </a>{' '}
              to see the build once Apple finishes processing it.
            </>
          }
        </div>
      )}
      {publish.state === 'failed' && (
        <div style={errorBox}>
          Publish failed{publish.exitCode !== undefined ? ` (exit code ${publish.exitCode})` : ''}. See the
          build log.
        </div>
      )}
    </Section>
  );
}
