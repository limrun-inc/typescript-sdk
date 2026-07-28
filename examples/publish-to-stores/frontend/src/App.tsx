// Publish-to-stores wizard: a Replit-style publishing pipeline for mobile
// apps. Both platforms submit detached builds and wait for terminal webhooks.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ConnectPhase } from './components/ConnectPhase';
import { PlayPhase } from './components/PlayPhase';
import { PublishPhase } from './components/PublishPhase';
import { ResultPanel } from './components/ResultPanel';
import { PUBLISHER_NAME } from './config';
import { useConnect } from './hooks/useConnect';
import { usePlay } from './hooks/usePlay';
import { usePublish } from './hooks/usePublish';
import {
  createBackendSecretStore,
  getSecretsDir,
  getWebhookUrl,
  setSecretsDir,
  setWebhookUrl,
} from './lib/backend';
import { errorBox, hintText, inputStyle, labelStyle, layout, tabBar, tabButton } from './theme';

function platformPane(visible: boolean): CSSProperties {
  return { display: visible ? 'flex' : 'none', flexDirection: 'column', gap: '18px' };
}

export default function App() {
  const [error, setError] = useState<string>();
  // Both pipelines stay mounted so tab switches do not clear form or polling state.
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

  // The secrets directory on the backend host. The chosen value persists in
  // localStorage and rides every store operation and publish; the field
  // defaults to the backend's current directory, advertised by /session.
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
  // localStorage and rides every publish request, where the backend hands it
  // to the lim CLI verbatim.
  const [webhookUrl, setWebhookUrlState] = useState(getWebhookUrl);
  const updateWebhookUrl = (url: string) => {
    setWebhookUrlState(url);
    setWebhookUrl(url);
  };

  // useAppleIDLogin does not throw: sign-in and two-factor failures land in
  // appleLogin.error, so it must be rendered alongside errors reported
  // through onError or failed logins would be invisible.
  const displayError = error ?? connect.appleLogin.error;

  return (
    <div style={layout.page}>
      <div style={layout.sidebar}>
        <h1 style={layout.title}>{PUBLISHER_NAME}</h1>
        <p style={hintText}>
          Publish an iOS app to the App Store, or an Android app to Google Play. The backend must run on this
          host with a valid LIM_API_KEY and the lim CLI installed.
        </p>
        <label style={labelStyle}>Secrets directory (on the backend host)</label>
        <input
          style={inputStyle}
          value={secretsDir}
          onChange={(event) => updateSecretsDir(event.target.value)}
          placeholder="backend default"
        />
        <label style={labelStyle}>Webhook URL for build completion (Run `ngrok http 3001`)</label>
        <input
          style={inputStyle}
          value={webhookUrl}
          onChange={(event) => updateWebhookUrl(event.target.value)}
          placeholder="https://your-subdomain.ngrok-free.app"
        />
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
          <PublishPhase connect={connect} publish={publish} webhookUrl={webhookUrl} />
        </div>
        <div style={platformPane(platform === 'android')}>
          <PlayPhase play={play} onError={setError} webhookUrl={webhookUrl} />
        </div>
      </div>
      <div style={layout.main}>
        <h2 style={{ margin: 0, fontSize: '16px' }}>Build result</h2>
        {platform === 'android' ?
          <ResultPanel publish={play} webhookUrl={webhookUrl} />
        : <ResultPanel publish={publish} webhookUrl={webhookUrl} />}
      </div>
    </div>
  );
}
