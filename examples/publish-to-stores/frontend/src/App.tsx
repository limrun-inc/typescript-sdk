// Publish-to-stores wizard: a Replit-style publishing pipeline for iOS apps.
// The sidebar walks through Connect (one-time Apple setup) and Publish
// (TestFlight / App Store upload); the main panel shows the build log.
import { useMemo, useState } from 'react';
import { ConnectPhase } from './components/ConnectPhase';
import { LogPanel } from './components/LogPanel';
import { PublishPhase } from './components/PublishPhase';
import { PUBLISHER_NAME } from './config';
import { useConnect } from './hooks/useConnect';
import { usePublish } from './hooks/usePublish';
import { createBackendSecretStore } from './lib/backend';
import { errorBox, hintText, layout } from './theme';

export default function App() {
  const [error, setError] = useState<string>();

  // The store is the pluggable piece: this one talks to the example
  // backend's file store, but any SigningSecretStore implementation works.
  const secretStore = useMemo(() => createBackendSecretStore(), []);

  const connect = useConnect({
    secretStore,
    log: (message, detail) => console.log(message, detail ?? ''),
    onError: setError,
  });
  const publish = usePublish();

  // useAppleIDLogin does not throw: sign-in and two-factor failures land in
  // appleLogin.error, so it must be rendered alongside errors reported
  // through onError or failed logins would be invisible.
  const displayError = error ?? connect.appleLogin.error;

  return (
    <div style={layout.page}>
      <div style={layout.sidebar}>
        <h1 style={layout.title}>{PUBLISHER_NAME}</h1>
        <p style={hintText}>
          Publish an iOS app to TestFlight or the App Store. The backend must run on this host with a valid
          LIM_API_KEY and the lim CLI installed.
        </p>
        {displayError && <div style={errorBox}>{displayError}</div>}
        <ConnectPhase connect={connect} />
        <PublishPhase connect={connect} publish={publish} />
      </div>
      <div style={layout.main}>
        <h2 style={{ margin: 0, fontSize: '16px' }}>Build log</h2>
        <LogPanel lines={publish.lines} />
      </div>
    </div>
  );
}
