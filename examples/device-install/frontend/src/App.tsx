import { useEffect, useState } from 'react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { useActivityLog } from './hooks/useActivityLog';
import { BACKEND_URL } from './config';
import { errorBox, layout } from './theme';
import { LogPanel } from './components/LogPanel';
import { PairStep } from './components/PairStep';
import { InstallStep } from './components/InstallStep';

type Session = { token: string; registryUrl: string; expiresAt: string };

/**
 * Pair an iPhone over WebUSB, then install a signed IPA onto it. Both talk to
 * Limrun's registry directly using a short-lived scoped token minted by
 * the example backend — the API key never reaches the browser, and the token
 * can only open the device relay and read the granted assets.
 *
 * There is deliberately no build step here: signed IPAs are produced on your
 * backend with `@limrun/api` and uploaded to Limrun asset storage, then
 * installed by asset name. See examples/publish-to-stores for the Apple
 * signing + build flow.
 */
function App() {
  const activity = useActivityLog();
  const [error, setError] = useState<string>();
  const [session, setSession] = useState<Session>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`Session request failed with ${response.status}`);
        const fresh: Session = await response.json();
        if (cancelled) return;
        setSession(fresh);
        activity.push('Registry session ready', `expires at ${fresh.expiresAt}`);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = useDeviceInstallRelay({
    registryApiUrl: session?.registryUrl,
    token: session?.token,
    log: activity.push,
  });

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
