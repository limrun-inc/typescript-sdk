import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useDeviceInstallRelay } from '../react';
import './demo.css';

type ActivityLine = {
  id: number;
  time: string;
  message: string;
  detail?: string;
};

type StepState = 'pending' | 'active' | 'done' | 'error';
type StepView = { state: StepState; label: string };
type PillTone = 'neutral' | 'active' | 'success' | 'danger';

const storageKeys = {
  registryApiUrl: 'limrun-device-demo-registry-api-url',
  registryToken: 'limrun-device-demo-registry-token',
  assetName: 'limrun-device-demo-asset-name',
  ipaDownloadUrl: 'limrun-device-demo-ipa-download-url',
};

function App() {
  const [registryApiUrl, setRegistryApiUrl] = useLocalStorage(
    storageKeys.registryApiUrl,
    'https://registry.limrun.com',
  );
  const [registryToken, setRegistryToken] = useLocalStorage(storageKeys.registryToken, '');
  const [assetName, setAssetName] = useLocalStorage(storageKeys.assetName, '');
  const [ipaDownloadUrl, setIPADownloadUrl] = useLocalStorage(storageKeys.ipaDownloadUrl, '');
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  const [dismissedError, setDismissedError] = useState<string>();
  const [installPhase, setInstallPhase] = useState<'idle' | 'installing' | 'done' | 'error'>('idle');

  const addActivity = (message: string, detail?: string) => {
    setActivity((current) =>
      [
        {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString(),
          message,
          detail,
        },
        ...current,
      ].slice(0, 120),
    );
    // Derive install completion from relay progress messages (the hook has no
    // explicit "installed" signal). Only act while an install is in flight so
    // pairing's "completed" messages don't flip this.
    setInstallPhase((phase) => {
      if (phase !== 'installing') return phase;
      if (/100% complete/i.test(message) || /install completed/i.test(message)) return 'done';
      if (/^server error/i.test(message) || /install failed/i.test(message)) return 'error';
      return phase;
    });
  };

  const install = useDeviceInstallRelay({
    registryApiUrl: registryApiUrl.trim() || undefined,
    token: registryToken.trim() || undefined,
    log: addActivity,
  });

  // Show the error as a floating toast (so it's visible without scrolling up)
  // until it's dismissed; a different error re-shows it.
  const visibleError = install.error && install.error !== dismissedError ? install.error : undefined;
  const selectedUDID = install.device?.hello.serialNumber;
  const hasInstallSource = !!assetName.trim() || !!ipaDownloadUrl.trim();
  const canInstall = install.canInstall && hasInstallSource;

  const pairStep: StepView =
    install.busyAction === 'usb' ? { state: 'active', label: 'Selecting device…' }
    : install.busyAction === 'pair' ? { state: 'active', label: 'Pairing…' }
    : install.hasPairRecord ? { state: 'done', label: 'Paired' }
    : install.device ? { state: 'active', label: 'Device selected' }
    : { state: 'pending', label: 'Not started' };
  const installStep: StepView =
    installPhase === 'done' ? { state: 'done', label: 'Installed' }
    : installPhase === 'error' ? { state: 'error', label: 'Failed' }
    : install.busyAction === 'install' || installPhase === 'installing' ?
      { state: 'active', label: 'Installing…' }
    : canInstall ? { state: 'active', label: 'Ready to install' }
    : { state: 'pending', label: 'Waiting' };

  async function runInstall() {
    setInstallPhase('installing');
    const relay = await install.startInstallation(
      assetName.trim() ? { assetName: assetName.trim() } : { url: ipaDownloadUrl.trim() },
    );
    if (!relay) setInstallPhase('error');
  }

  return (
    <main className="page">
      <header className="hero">
        <p className="eyebrow">Limrun WebUSB Demo</p>
        <h1>Install a signed IPA onto a physical iPhone</h1>
        <p>
          Select an iPhone, pair it, and install a signed IPA from your Limrun asset storage (or any HTTPS
          URL) over WebUSB. The registry downloads the artifact and streams it to the phone; producing the
          signed IPA is a backend concern (build with <code>@limrun/api</code> and upload it as an asset).
        </p>
      </header>

      <section className="stepper">
        {[
          { n: 1, title: 'Pair', step: pairStep },
          { n: 2, title: 'Install', step: installStep },
        ].map(({ n, title, step }) => (
          <div key={n} className={`step ${step.state}`}>
            <span className="stepDot">
              {step.state === 'done' ?
                '✓'
              : step.state === 'error' ?
                '!'
              : n}
            </span>
            <div className="stepText">
              <span className="stepTitle">{title}</span>
              <span className="stepLabel">{step.label}</span>
            </div>
          </div>
        ))}
      </section>

      {visibleError && (
        <div className="errorToast" role="alert">
          <div className="errorToastBody">
            <strong>Something went wrong</strong>
            <pre>{visibleError}</pre>
          </div>
          <button
            type="button"
            className="errorToastClose"
            aria-label="Dismiss"
            onClick={() => setDismissedError(install.error)}
          >
            ✕
          </button>
        </div>
      )}

      <section className="card">
        <h2>Connection</h2>
        <div className="grid two">
          <label>
            Registry API URL
            <input
              value={registryApiUrl}
              onChange={(event) => setRegistryApiUrl(event.currentTarget.value)}
              placeholder="https://registry.limrun.com"
            />
          </label>
          <label>
            Registry token
            <input
              value={registryToken}
              onChange={(event) => setRegistryToken(event.currentTarget.value)}
              placeholder="Limrun token for the registry"
            />
          </label>
        </div>
        <p className="hint">
          Run this page on <code>localhost</code> or HTTPS. WebUSB is available in Chromium browsers only.
        </p>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>1. Pair iPhone</h2>
            <p>Select the USB device, then pair. Unlock the iPhone and tap Trust.</p>
          </div>
          <StatusPill tone={pillTone(pairStep.state)}>{pairStep.label}</StatusPill>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!registryApiUrl.trim() || !!install.busyAction}
            onClick={() => void install.requestUSBAccess()}
          >
            Select iPhone
          </button>
          <button type="button" disabled={!install.canPair} onClick={() => void install.pairBrowser()}>
            Pair
          </button>
          <button type="button" className="secondary" onClick={install.stopRelay}>
            Stop relay
          </button>
        </div>
        <dl className="facts">
          <div>
            <dt>Device</dt>
            <dd>{install.device?.hello.productName ?? 'Not selected'}</dd>
          </div>
          <div>
            <dt>UDID</dt>
            <dd>{selectedUDID ?? 'Not selected'}</dd>
          </div>
          <div>
            <dt>Busy action</dt>
            <dd>{install.busyAction ?? 'idle'}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>2. Install</h2>
            <p>
              Install by asset name (an IPA in your organization's asset storage) or by direct HTTPS URL. The
              IPA must be signed with a development profile that includes the paired iPhone's UDID.
            </p>
          </div>
          <StatusPill tone={pillTone(installStep.state)}>{installStep.label}</StatusPill>
        </div>
        <div className="grid two">
          <label>
            Asset name
            <input
              value={assetName}
              onChange={(event) => setAssetName(event.currentTarget.value)}
              placeholder="my-app.ipa"
            />
          </label>
          <label>
            IPA download URL (used when asset name is empty)
            <input
              value={ipaDownloadUrl}
              onChange={(event) => setIPADownloadUrl(event.currentTarget.value)}
              placeholder="https://example.com/app.ipa"
            />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!canInstall || installPhase === 'installing'}
            onClick={() => void runInstall()}
          >
            Install to iPhone
          </button>
        </div>
      </section>

      <section className="card">
        <div className="sectionHeader">
          <div>
            <h2>Activity</h2>
            <p>Device, relay, and install events.</p>
          </div>
          <button type="button" className="secondary" onClick={() => setActivity([])}>
            Clear
          </button>
        </div>
        <div className="activity">
          {activity.length === 0 ?
            <p className="hint">No activity yet.</p>
          : activity.map((line) => (
              <div key={line.id} className="activityLine">
                <span>{line.time}</span>
                <strong>{line.message}</strong>
                {line.detail && <pre>{line.detail}</pre>}
              </div>
            ))
          }
        </div>
      </section>
    </main>
  );
}

function pillTone(state: StepState): PillTone {
  return (
    state === 'done' ? 'success'
    : state === 'error' ? 'danger'
    : state === 'active' ? 'active'
    : 'neutral'
  );
}

function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function useLocalStorage(key: string, initialValue: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initialValue);
  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
