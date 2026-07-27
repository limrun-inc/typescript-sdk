// The Publish phase stays focused on App Store Connect uploads. Both choices
// use the same distribution signing and detached webhook-backed build.
import { useState } from 'react';
import type { ConnectController } from '../hooks/useConnect';
import type { PublishController } from '../hooks/usePublish';
import type { PublishMethod } from '../lib/backend';
import { errorBox, hintText, infoBox, inputStyle, labelStyle, methodCard, primaryButton } from '../theme';
import { Section } from './Section';

type MethodCardSpec = {
  id: PublishMethod;
  label: string;
  description: string;
};

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
  },
  {
    id: 'appstore',
    label: 'App Store',
    description: 'Upload the build, then submit it for review in App Store Connect.',
  },
];

export function PublishPhase({
  connect,
  publish,
}: {
  connect: ConnectController;
  publish: PublishController;
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
            style={methodCard(publish.method === spec.id, false)}
            disabled={running}
            onClick={() => publish.setMethod(spec.id)}
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
        {running ? 'Waiting for build callback…' : `Publish ${connection.bundleId} via ${publish.method}`}
      </button>
      {publish.state === 'succeeded' && (
        <div style={infoBox}>
          Publish succeeded.{' '}
          <a href={appStoreConnectUrl(publish.method, connection.ascAppId)} target="_blank" rel="noreferrer">
            Open the {publish.method === 'testflight' ? 'TestFlight' : 'App Store'} page in App Store Connect
          </a>
          {publish.method === 'appstore' ?
            ' to attach the processed build to a version and submit it for review.'
          : ' to see the build once Apple finishes processing it.'}
        </div>
      )}
      {publish.state === 'failed' && (
        <div style={errorBox}>Publish failed{publish.error ? `: ${publish.error}` : '.'}</div>
      )}
    </Section>
  );
}
