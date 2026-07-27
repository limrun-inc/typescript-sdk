import { useMemo, useState } from 'react';
import { ConnectPhase } from './components/ConnectPhase';
import { InstallPhase } from './components/InstallPhase';
import { ResultPanel } from './components/ResultPanel';
import { INSTALLER_NAME } from './config';
import { useConnect } from './hooks/useConnect';
import { useDeviceInstall } from './hooks/useDeviceInstall';
import { useInstall } from './hooks/useInstall';
import { createBackendSecretStore } from './lib/backend';
import { errorBox, hintText, layout } from './theme';

export default function App() {
  const [error, setError] = useState<string>();
  const secretStore = useMemo(() => createBackendSecretStore(), []);
  const connect = useConnect({
    secretStore,
    log: (message, detail) => console.log(message, detail ?? ''),
    onError: setError,
  });
  const build = useInstall();
  const device = useDeviceInstall({ connect, build, onError: setError });
  const displayError = error ?? connect.appleLogin.error ?? device.install.error ?? device.ota.error;

  return (
    <div style={layout.page}>
      <aside style={layout.sidebar}>
        <h1 style={layout.title}>{INSTALLER_NAME}</h1>
        <p style={hintText}>
          Build and install an iOS app through automatic WebUSB or a private QR/OTA page. The backend needs
          LIM_API_KEY and the lim CLI.
        </p>
        {displayError && <div style={errorBox}>{displayError}</div>}
        <ConnectPhase connect={connect} />
        <InstallPhase connect={connect} build={build} device={device} />
      </aside>
      <main style={layout.main}>
        <h2 style={{ margin: 0, fontSize: '16px' }}>Build result</h2>
        <ResultPanel build={build} device={device} />
      </main>
    </div>
  );
}
