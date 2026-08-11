import { useEffect, useMemo, useState } from 'react';
import { ConnectPhase } from './components/ConnectPhase';
import { DevicesPhase } from './components/DevicesPhase';
import { BuildPhase, InstallPhase } from './components/InstallPhase';
import { ResultPanel } from './components/ResultPanel';
import { INSTALLER_NAME } from './config';
import { useConnect } from './hooks/useConnect';
import { useDeviceInstall } from './hooks/useDeviceInstall';
import { useInstall } from './hooks/useInstall';
import {
  createBackendSecretStore,
  getSecretsDir,
  getWebhookUrl,
  setSecretsDir,
  setWebhookUrl,
} from './lib/backend';
import { errorBox, hintText, inputStyle, labelStyle, layout } from './theme';

export default function App() {
  const [error, setError] = useState<string>();
  const secretStore = useMemo(() => createBackendSecretStore(), []);
  const connect = useConnect({
    secretStore,
    log: (message, detail) => console.log(message, detail ?? ''),
    onError: setError,
  });
  const build = useInstall();
  const device = useDeviceInstall({ build, onError: setError });
  const displayError = error ?? connect.appleLogin.error ?? device.ota.error;

  // The secrets directory on the backend host. The chosen value persists in
  // localStorage and rides every store operation and install build; the
  // field defaults to the backend's current directory, advertised by
  // /session.
  const [secretsDir, setSecretsDirState] = useState(getSecretsDir);
  useEffect(() => {
    const fallback = connect.registrySession?.secretsDir;
    if (fallback) setSecretsDirState((current) => current || fallback);
  }, [connect.registrySession?.secretsDir]);
  const updateSecretsDir = (dir: string) => {
    setSecretsDirState(dir);
    setSecretsDir(dir);
  };

  // The public URL limbuild POSTs build-finish webhooks to. It persists in
  // localStorage and rides every install build request, where the backend
  // hands it to the lim CLI verbatim.
  const [webhookUrl, setWebhookUrlState] = useState(getWebhookUrl);
  const updateWebhookUrl = (url: string) => {
    setWebhookUrlState(url);
    setWebhookUrl(url);
  };

  return (
    <div style={layout.page}>
      <aside style={layout.sidebar}>
        <h1 style={layout.title}>{INSTALLER_NAME}</h1>
        <p style={hintText}>
          Build an ad-hoc-signed iOS app and install it on a registered iPhone through a private QR/OTA page.
          The backend needs LIM_API_KEY and the lim CLI.
        </p>
        <label style={labelStyle}>Secrets directory (on the backend host)</label>
        <input
          style={inputStyle}
          value={secretsDir}
          onChange={(event) => updateSecretsDir(event.target.value)}
          placeholder="backend default"
        />
        <label style={labelStyle}>Webhook URL (Run `npx localtunnel --port 3001`)</label>
        <input
          style={inputStyle}
          value={webhookUrl}
          onChange={(event) => updateWebhookUrl(event.target.value)}
          placeholder="https://your-subdomain.ngrok-free.app"
        />
        {displayError && <div style={errorBox}>{displayError}</div>}
        <ConnectPhase connect={connect} />
        <DevicesPhase connect={connect} />
        <BuildPhase connect={connect} build={build} webhookUrl={webhookUrl} />
        <InstallPhase build={build} device={device} />
      </aside>
      <main style={layout.main}>
        <h2 style={{ margin: 0, fontSize: '16px' }}>Build result</h2>
        <ResultPanel build={build} device={device} />
      </main>
    </div>
  );
}
