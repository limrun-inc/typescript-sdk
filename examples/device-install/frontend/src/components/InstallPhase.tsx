import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ConnectController } from '../hooks/useConnect';
import type { DeviceInstallController } from '../hooks/useDeviceInstall';
import type { InstallController } from '../hooks/useInstall';
import type { InstallMethod } from '../lib/backend';
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

const METHODS: Array<{ id: InstallMethod; label: string; description: string }> = [
  {
    id: 'webusb',
    label: 'WebUSB',
    description: 'Development-sign, build, and automatically install on a paired iPhone.',
  },
  {
    id: 'qr',
    label: 'QR / private OTA',
    description: 'Ad-hoc-sign and create a private install page; pairing is not required.',
  },
];

function InstallQRCode({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).then((value) => {
      if (!cancelled) setDataUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return dataUrl ?
      <img src={dataUrl} alt="QR code for the private OTA install page" width={240} height={240} />
    : null;
}

function bytes(value?: number) {
  if (value === undefined) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function InstallPhase({
  connect,
  build,
  device,
}: {
  connect: ConnectController;
  build: InstallController;
  device: DeviceInstallController;
}) {
  const [projectPath, setProjectPath] = useState('');
  if (!connect.connection) {
    return (
      <Section title="2. Build and install">
        <p style={hintText}>Locked. Complete Apple setup first.</p>
      </Section>
    );
  }

  const profileKind = build.method === 'qr' ? 'adhoc' : 'development';
  const running = build.state === 'running';
  const deviceReady =
    !!device.install.device &&
    (build.method === 'qr' || device.install.hasPairRecord) &&
    device.enrollmentReady(profileKind);
  const canBuild = !running && !!projectPath.trim() && deviceReady;

  return (
    <Section title="2. Build and install">
      <label style={labelStyle}>Project path (on the backend host)</label>
      <input
        style={inputStyle}
        value={projectPath}
        onChange={(event) => setProjectPath(event.target.value)}
        placeholder="/path/to/MyApp"
      />
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {METHODS.map((method) => (
          <button
            key={method.id}
            style={methodCard(build.method === method.id, running)}
            disabled={running}
            onClick={() => build.setMethod(method.id)}
          >
            <strong>{method.label}</strong>
            <br />
            <span style={hintText}>{method.description}</span>
          </button>
        ))}
      </div>

      <label style={labelStyle}>Target iPhone</label>
      <button
        style={secondaryButton(device.install.busyAction === 'usb' || running)}
        disabled={running}
        onClick={() => {
          device.install.clearError();
          void device.install.requestUSBAccess();
        }}
      >
        {device.install.device ?
          `Selected: ${device.install.device.hello.productName}`
        : device.install.busyAction === 'usb' ?
          'Opening device picker…'
        : 'Select iPhone'}
      </button>

      {build.method === 'webusb' && (
        <>
          <button
            style={secondaryButton(!device.install.canPair || running)}
            disabled={!device.install.canPair || running}
            onClick={() => {
              device.install.clearError();
              void device.install.pairBrowser();
            }}
          >
            {device.install.busyAction === 'pair' ? 'Pairing…' : 'Pair (tap Trust on iPhone)'}
          </button>
          {device.install.pairConfirmationRequired && (
            <div style={warnBox}>Unlock the iPhone, tap Trust, then choose Pair again.</div>
          )}
          {device.install.hasPairRecord && (
            <div style={infoBox}>Paired. The pair record is stored only in this browser.</div>
          )}
        </>
      )}

      <button
        style={secondaryButton(
          !device.install.device ||
            (build.method === 'webusb' && !device.install.hasPairRecord) ||
            connect.busy === 'device-enrollment',
        )}
        disabled={
          !device.install.device ||
          (build.method === 'webusb' && !device.install.hasPairRecord) ||
          connect.busy === 'device-enrollment' ||
          running
        }
        onClick={() => void device.prepareSelectedDevice(profileKind)}
      >
        {connect.busy === 'device-enrollment' || connect.deviceEnrollment.status === 'checking' ?
          'Preparing signing…'
        : `Register device and prepare ${profileKind === 'adhoc' ? 'ad-hoc' : 'development'} signing`}
      </button>
      {connect.deviceEnrollment.note && (
        <div
          style={
            connect.deviceEnrollment.status === 'error' || connect.deviceEnrollment.status === 'needs-login' ?
              warnBox
            : infoBox
          }
        >
          {connect.deviceEnrollment.note}
        </div>
      )}

      <button
        style={primaryButton(!canBuild)}
        disabled={!canBuild}
        onClick={() =>
          void build.build({
            projectPath: projectPath.trim(),
            method: build.method,
            teamId: connect.connection!.teamId,
            bundleId: connect.connection!.bundleId,
            deviceUDID: device.selectedUDID!,
          })
        }
      >
        {running ?
          'Waiting for build callback…'
        : `Build and ${build.method === 'webusb' ? 'install automatically' : 'create QR install'}`}
      </button>

      {build.state === 'failed' && (
        <div style={errorBox}>Build failed{build.error ? `: ${build.error}` : '.'}</div>
      )}
      {build.state === 'succeeded' && build.method === 'webusb' && (
        <div style={infoBox}>
          IPA uploaded.{' '}
          {device.installState === 'authorizing' || device.installState === 'waiting' ?
            'Authorizing automatic installation…'
          : device.installState === 'installing' ?
            'Starting installation…'
          : device.installState === 'started' ?
            'Installation started. Keep the iPhone connected and unlocked.'
          : device.installState === 'failed' ?
            <>
              Automatic installation failed.{' '}
              <button style={secondaryButton(false)} onClick={device.retryInstallation}>
                Retry
              </button>
            </>
          : 'Waiting to install…'}
        </div>
      )}
      {build.state === 'succeeded' && build.method === 'qr' && (
        <div style={infoBox}>
          {device.ota.session ?
            <>
              <InstallQRCode url={device.ota.session.installPageUrl} />
              <div>
                <a href={device.ota.session.installPageUrl} target="_blank" rel="noreferrer">
                  Open the private iPhone install page
                </a>
              </div>
              {device.ota.status && (
                <div style={{ marginTop: '10px' }}>
                  <progress max={1} value={device.ota.status.progress} style={{ width: '100%' }} />
                  <div>
                    {Math.round(device.ota.status.progress * 100)}% — {bytes(device.ota.status.bytesTransferred)} of{' '}
                    {bytes(device.ota.status.totalBytes)} served
                  </div>
                  {device.ota.status.state === 'downloaded' && (
                    <div>
                      IPA bytes were delivered to iOS. Final verification and installation are not observable.
                    </div>
                  )}
                </div>
              )}
            </>
          : device.ota.error ?
            <>
              OTA session failed: {device.ota.error}{' '}
              <button style={secondaryButton(false)} onClick={device.retryOTA}>
                Retry
              </button>
            </>
          : 'Authorizing the private OTA install page…'}
        </div>
      )}
    </Section>
  );
}
