import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ConnectController } from '../hooks/useConnect';
import type { DeviceInstallController } from '../hooks/useDeviceInstall';
import type { InstallController } from '../hooks/useInstall';
import { getWebhookUrl, setWebhookUrl } from '../lib/backend';
import {
  errorBox,
  hintText,
  infoBox,
  inputStyle,
  labelStyle,
  primaryButton,
  secondaryButton,
} from '../theme';
import { Section } from './Section';

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

/**
 * Stage 3: the single ad-hoc-signed build (distribution certificate +
 * ad-hoc profile, chosen server-side by the target device's UDID).
 */
export function BuildPhase({ connect, build }: { connect: ConnectController; build: InstallController }) {
  const [projectPath, setProjectPath] = useState('');
  // The public URL limbuild POSTs build-finish webhooks to. It persists in
  // localStorage and rides the build request, where the backend hands it to
  // the lim CLI verbatim.
  const [webhookUrl, setWebhookUrlState] = useState(getWebhookUrl);
  const updateWebhookUrl = (url: string) => {
    setWebhookUrlState(url);
    setWebhookUrl(url);
  };
  if (!connect.connection || !connect.selectedDevice?.covered) {
    return (
      <Section title="3. Build">
        <p style={hintText}>Locked. Pick a covered target iPhone first.</p>
      </Section>
    );
  }

  const running = build.state === 'running';
  const webhookUrlSet = webhookUrl.trim() !== '';
  const canBuild = !running && !!projectPath.trim() && webhookUrlSet;

  return (
    <Section title="3. Build">
      <label style={labelStyle}>Project path (on the backend host)</label>
      <input
        style={inputStyle}
        value={projectPath}
        onChange={(event) => setProjectPath(event.target.value)}
        placeholder="/path/to/MyApp"
      />
      <label style={labelStyle}>Webhook URL (Run `npx localtunnel --port 3001`)</label>
      <input
        style={inputStyle}
        value={webhookUrl}
        onChange={(event) => updateWebhookUrl(event.target.value)}
        placeholder="https://your-subdomain.ngrok-free.app"
      />
      {!webhookUrlSet && <p style={hintText}>Enter the webhook URL to enable building.</p>}
      <button
        style={primaryButton(!canBuild)}
        disabled={!canBuild}
        onClick={() =>
          void build.build({
            projectPath: projectPath.trim(),
            teamId: connect.connection!.teamId,
            bundleId: connect.connection!.bundleId,
            deviceUDID: connect.selectedDevice!.udid,
            webhookUrl: webhookUrl.trim(),
          })
        }
      >
        {running ? 'Waiting for build callback…' : 'Build ad-hoc-signed IPA'}
      </button>
      {build.state === 'failed' && (
        <div style={errorBox}>Build failed{build.error ? `: ${build.error}` : '.'}</div>
      )}
      {build.state === 'succeeded' && <div style={infoBox}>IPA built and uploaded.</div>}
    </Section>
  );
}

/**
 * Stage 4: QR installation. Once the build's asset is authorized, one
 * button creates the private OTA session; the QR code encodes its install
 * page URL, where the phone taps Install to fire the itms-services
 * deeplink. Progress comes from polling the session's status URL.
 */
export function InstallPhase({
  build,
  device,
}: {
  build: InstallController;
  device: DeviceInstallController;
}) {
  if (build.state !== 'succeeded') {
    return (
      <Section title="4. Install via QR">
        <p style={hintText}>Locked. Finish a build first.</p>
      </Section>
    );
  }

  return (
    <Section title="4. Install via QR">
      {device.authorization === 'authorizing' && (
        <p style={hintText}>Authorizing the built IPA for installation…</p>
      )}
      {device.authorization === 'failed' && (
        <div style={errorBox}>
          Could not authorize the built IPA.{' '}
          <button style={secondaryButton(false)} onClick={device.retryAuthorization}>
            Retry
          </button>
        </div>
      )}
      {device.authorization === 'ready' && !device.ota.session && (
        <>
          <button
            style={primaryButton(device.ota.busy)}
            disabled={device.ota.busy}
            onClick={device.startQRInstall}
          >
            {device.ota.busy ? 'Creating install page…' : 'Create QR install'}
          </button>
          {device.ota.error && (
            <div style={errorBox}>
              OTA session failed: {device.ota.error}{' '}
              <button style={secondaryButton(false)} onClick={device.startQRInstall}>
                Retry
              </button>
            </div>
          )}
        </>
      )}
      {device.ota.session && (
        <div style={infoBox}>
          <InstallQRCode url={device.ota.session.installPageUrl} />
          <div>
            <a href={device.ota.session.installPageUrl} target="_blank" rel="noreferrer">
              Open the private iPhone install page
            </a>
          </div>
          <p style={hintText}>
            Scan with the registered iPhone, then tap Install on the page. iOS shows its own confirmation
            prompt.
          </p>
          {device.ota.status && (
            <div style={{ marginTop: '10px' }}>
              <progress max={1} value={device.ota.status.progress} style={{ width: '100%' }} />
              <div>
                {Math.round(device.ota.status.progress * 100)}% — {bytes(device.ota.status.bytesTransferred)}{' '}
                of {bytes(device.ota.status.totalBytes)} served
              </div>
              {device.ota.status.state === 'downloaded' && (
                <div>
                  IPA bytes were delivered to iOS. Final verification and installation are not observable.
                </div>
              )}
              {device.ota.status.state === 'failed' && (
                <div style={errorBox}>
                  Delivery failed{device.ota.status.error ? `: ${device.ota.status.error}` : '.'}
                </div>
              )}
              {device.ota.status.state === 'expired' && (
                <div style={errorBox}>
                  The install page expired.{' '}
                  <button
                    style={secondaryButton(false)}
                    onClick={() => {
                      device.ota.reset();
                      device.startQRInstall();
                    }}
                  >
                    Create a new one
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
