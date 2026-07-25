// The Publish phase UI: project path, method cards, and the publish
// trigger. Store publishes use distribution/ASC credentials; WebUSB uses a
// paired iPhone and device-specific development signing.
import { useState } from 'react';
import type { ConnectController } from '../hooks/useConnect';
import type { PublishController } from '../hooks/usePublish';
import type { WebUsbController } from '../hooks/useWebUsbPublish';
import type { PublishMethod } from '../lib/backend';
import {
  errorBox,
  hintText,
  infoBox,
  inputStyle,
  labelStyle,
  methodCard,
  primaryButton,
  secondaryButton,
  warnBox,
} from '../theme';
import { Section } from './Section';

type MethodCardSpec = {
  id: PublishMethod | 'qr';
  label: string;
  description: string;
  enabled: boolean;
};

/**
 * The App Store Connect page a finished upload lands on. With the app
 * record ID (captured during Connect) this deep-links into the app's
 * TestFlight builds or App Store version page; without it, the apps list.
 */
function appStoreConnectUrl(method: 'testflight' | 'appstore', ascAppId?: string) {
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
    description: 'Build a development-signed IPA and install it on a paired iPhone.',
    enabled: true,
  },
  { id: 'qr', label: 'QR code', description: 'Ad-hoc install via QR. Next iteration.', enabled: false },
];

export function PublishPhase({
  connect,
  publish,
  webUsb,
}: {
  connect: ConnectController;
  publish: PublishController;
  webUsb: WebUsbController;
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
  const webUsbReady =
    publish.method !== 'webusb' ||
    (!!webUsb.install.device && webUsb.install.hasPairRecord && webUsb.enrollmentReady);
  const canPublish = !running && projectPath.trim() !== '' && webUsbReady;

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
      {publish.method === 'webusb' && (
        <div style={{ border: '1px solid #d8dee8', borderRadius: '8px', padding: '12px' }}>
          <label style={labelStyle}>Connected iPhone</label>
          <button
            style={secondaryButton(webUsb.install.busyAction === 'usb' || running)}
            disabled={running}
            onClick={() => {
              webUsb.install.clearError();
              void webUsb.install.requestUSBAccess();
            }}
          >
            {webUsb.install.device ?
              `Selected: ${webUsb.install.device.hello.productName}`
            : webUsb.install.busyAction === 'usb' ?
              'Opening device picker…'
            : 'Select iPhone (WebUSB)'}
          </button>
          <button
            style={secondaryButton(!webUsb.install.canPair || running)}
            disabled={!webUsb.install.canPair || running}
            onClick={() => {
              webUsb.install.clearError();
              void webUsb.install.pairBrowser();
            }}
          >
            {webUsb.install.busyAction === 'pair' ? 'Pairing…' : 'Pair (tap Trust on iPhone)'}
          </button>
          {webUsb.install.pairConfirmationRequired && (
            <div style={warnBox}>Unlock the iPhone, tap Trust, then choose Pair again.</div>
          )}
          {webUsb.install.hasPairRecord && (
            <div style={infoBox}>Paired. The pair record is stored only in this browser.</div>
          )}
          <button
            style={secondaryButton(
              !webUsb.install.hasPairRecord ||
                connect.busy === 'webusb-enrollment' ||
                connect.webUsbEnrollment.status === 'checking',
            )}
            disabled={
              !webUsb.install.hasPairRecord ||
              connect.busy === 'webusb-enrollment' ||
              connect.webUsbEnrollment.status === 'checking' ||
              running
            }
            onClick={() => void webUsb.prepareSelectedDevice()}
          >
            {connect.busy === 'webusb-enrollment' || connect.webUsbEnrollment.status === 'checking' ?
              'Preparing Apple signing…'
            : 'Prepare device for signing'}
          </button>
          {connect.webUsbEnrollment.note && (
            <div
              style={
                (
                  connect.webUsbEnrollment.status === 'error' ||
                  connect.webUsbEnrollment.status === 'needs-login'
                ) ?
                  warnBox
                : infoBox
              }
            >
              {connect.webUsbEnrollment.note}
            </div>
          )}
          {!webUsb.enrollmentReady && <p style={hintText}>Prepare this paired iPhone before building.</p>}
          {webUsb.activity.length > 0 && (
            <div
              style={{
                background: '#111820',
                borderRadius: '6px',
                color: '#d7e0ea',
                fontFamily: 'monospace',
                fontSize: '11px',
                maxHeight: '140px',
                overflow: 'auto',
                padding: '8px',
              }}
            >
              {webUsb.activity.map((entry, index) => (
                <div key={`${entry.at}-${index}`}>
                  <span style={{ color: '#8290a0' }}>{entry.at} </span>
                  {entry.message}
                  {entry.detail ?
                    <span style={{ color: '#9fabb7' }}> — {entry.detail}</span>
                  : null}
                </div>
              ))}
            </div>
          )}
          {webUsb.installState === 'failed' && (
            <button style={secondaryButton(false)} onClick={webUsb.retryInstallation}>
              Retry installation
            </button>
          )}
        </div>
      )}
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
            deviceUDID: publish.method === 'webusb' ? webUsb.selectedUDID : undefined,
          })
        }
      >
        {running ? 'Waiting for build callback…' : `Publish ${connection.bundleId} via ${publish.method}`}
      </button>
      {publish.state === 'succeeded' && (
        <div style={infoBox}>
          {publish.method === 'webusb' ?
            <>
              IPA build and upload succeeded.{' '}
              {webUsb.installState === 'authorizing' || webUsb.installState === 'waiting' ?
                'Authorizing automatic installation…'
              : webUsb.installState === 'installing' ?
                'Starting installation on the iPhone…'
              : webUsb.installState === 'started' ?
                'Installation started. Keep the iPhone connected and unlocked.'
              : webUsb.installState === 'failed' ?
                'Automatic installation failed; review the error and activity above.'
              : 'Waiting to install on the paired iPhone…'}
            </>
          : publish.method === 'appstore' ?
            <>
              Publish succeeded.{' '}
              <a href={appStoreConnectUrl('appstore', connection.ascAppId)} target="_blank" rel="noreferrer">
                Open the App Store page in App Store Connect
              </a>{' '}
              to attach the processed build to a version and submit it for review.
            </>
          : <>
              Publish succeeded.{' '}
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
        <div style={errorBox}>Publish failed{publish.error ? `: ${publish.error}` : '.'}</div>
      )}
    </Section>
  );
}
