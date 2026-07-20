import { useState } from 'react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { useActivityLog } from './hooks/useActivityLog';
import { BACKEND_URL } from './config';
import { errorBox, layout } from './theme';
import { LogPanel } from './components/LogPanel';
import { PairStep } from './components/PairStep';
import { InstallStep } from './components/InstallStep';

/**
 * Pair an iPhone over WebUSB, then install a signed IPA onto it. Both run on
 * Limrun's registry, reached through the example backend's WebSocket proxy so
 * the API key stays server-side — `registryApiUrl` points at the backend.
 *
 * There is deliberately no build step here: signed IPAs are produced on your
 * backend with `@limrun/api` and uploaded to Limrun asset storage, then
 * installed by asset name. See examples/publish-to-stores for the Apple
 * signing + build flow.
 */
function App() {
  const activity = useActivityLog();
  const [error, setError] = useState<string>();

  const install = useDeviceInstallRelay({ registryApiUrl: BACKEND_URL, log: activity.push });

  return (
    <div style={layout.page}>
      <aside style={layout.sidebar}>
        <h1 style={layout.title}>Limrun Device Install</h1>

        <PairStep install={install} onError={setError} />
        <InstallStep install={install} onError={setError} />

        {(error || install.error) && <div style={errorBox}>{error || install.error}</div>}
      </aside>

      <main style={layout.main}>
        <div style={layout.panels}>
          <LogPanel title="Activity" scrollKey={activity.entries.length}>
            {activity.entries.length === 0 ?
              <span style={{ color: '#8b949e' }}>Nothing yet.</span>
            : activity.entries.map((entry, i) => (
                <div key={i} style={{ color: '#e6edf3', marginBottom: '2px' }}>
                  <span style={{ color: '#8b949e' }}>{entry.at} </span>
                  {entry.message}
                  {entry.detail ?
                    <span style={{ color: '#9aa6b2' }}> — {entry.detail}</span>
                  : null}
                </div>
              ))
            }
          </LogPanel>
        </div>
      </main>
    </div>
  );
}

export default App;
