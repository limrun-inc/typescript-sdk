// Publish-to-stores wizard: a Replit-style publishing pipeline for mobile
// apps. The sidebar's iOS tab walks through Connect (one-time Apple setup)
// and Publish (TestFlight / App Store upload); the Android tab publishes a
// signed AAB to Google Play. The main panel shows the selected platform's
// build log.
import { useMemo, useState, type CSSProperties } from 'react';
import { ConnectPhase } from './components/ConnectPhase';
import { LogPanel } from './components/LogPanel';
import { PlayPhase } from './components/PlayPhase';
import { PublishPhase } from './components/PublishPhase';
import { PUBLISHER_NAME } from './config';
import { useConnect } from './hooks/useConnect';
import { usePlay } from './hooks/usePlay';
import { usePublish } from './hooks/usePublish';
import { createBackendSecretStore } from './lib/backend';
import { errorBox, hintText, layout, tabBar, tabButton } from './theme';

function platformPane(visible: boolean): CSSProperties {
  return { display: visible ? 'flex' : 'none', flexDirection: 'column', gap: '18px' };
}

export default function App() {
  const [error, setError] = useState<string>();
  // Both pipelines stay mounted so a running build keeps streaming while
  // the user looks at the other tab; the log panel follows the selection.
  const [platform, setPlatform] = useState<'ios' | 'android'>('ios');

  // The store is the pluggable piece: this one talks to the example
  // backend's file store, but any SigningSecretStore implementation works.
  const secretStore = useMemo(() => createBackendSecretStore(), []);

  const connect = useConnect({
    secretStore,
    log: (message, detail) => console.log(message, detail ?? ''),
    onError: setError,
  });
  const publish = usePublish();
  const play = usePlay({ secretStore, onError: setError });

  // useAppleIDLogin does not throw: sign-in and two-factor failures land in
  // appleLogin.error, so it must be rendered alongside errors reported
  // through onError or failed logins would be invisible.
  const displayError = error ?? connect.appleLogin.error;

  return (
    <div style={layout.page}>
      <div style={layout.sidebar}>
        <h1 style={layout.title}>{PUBLISHER_NAME}</h1>
        <p style={hintText}>
          Publish an iOS app to TestFlight or the App Store, or an Android app to Google Play. The backend
          must run on this host with a valid LIM_API_KEY and the lim CLI installed.
        </p>
        <div style={tabBar}>
          <button style={tabButton(platform === 'ios')} onClick={() => setPlatform('ios')}>
            iOS
          </button>
          <button style={tabButton(platform === 'android')} onClick={() => setPlatform('android')}>
            Android
          </button>
        </div>
        {displayError && <div style={errorBox}>{displayError}</div>}
        {/* Hidden, not unmounted: tab switches must not clear form state. */}
        <div style={platformPane(platform === 'ios')}>
          <ConnectPhase connect={connect} />
          <PublishPhase connect={connect} publish={publish} />
        </div>
        <div style={platformPane(platform === 'android')}>
          <PlayPhase play={play} onError={setError} />
        </div>
      </div>
      <div style={layout.main}>
        <h2 style={{ margin: 0, fontSize: '16px' }}>Build log</h2>
        <LogPanel lines={platform === 'android' ? play.lines : publish.lines} />
      </div>
    </div>
  );
}
