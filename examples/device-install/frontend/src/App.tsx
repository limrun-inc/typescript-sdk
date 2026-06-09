import { useCallback, useMemo, useState } from 'react';
import { importSigningAssetsFromFiles, type StoredSigningAssets } from '@limrun/ui/device-build';
import { useDeviceBuild } from '@limrun/ui/device-build/react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';

type Sandbox = { id: string; apiUrl: string; token: string };

type LogEntry = { at: string; message: string; detail?: string };

function App() {
  const [sandbox, setSandbox] = useState<Sandbox | undefined>();
  const [provisioning, setProvisioning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [log, setLog] = useState<LogEntry[]>([]);

  // Signing inputs (upload path).
  const [bundleId, setBundleId] = useState('');
  const [certificateFile, setCertificateFile] = useState<File>();
  const [provisioningProfileFile, setProvisioningProfileFile] = useState<File>();
  const [certificatePassword, setCertificatePassword] = useState('');
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets>();
  const [signing, setSigning] = useState(false);

  const pushLog = useCallback((message: string, detail?: unknown) => {
    setLog((current) => [
      { at: new Date().toLocaleTimeString(), message, detail: detail ? String(detail) : undefined },
      ...current,
    ]);
  }, []);

  const apiUrl = sandbox?.apiUrl;
  const token = sandbox?.token;

  const install = useDeviceInstallRelay({ apiUrl, token, log: pushLog });
  const build = useDeviceBuild({ apiUrl, token, signingAssets });

  const deviceUDID = install.device?.hello.serialNumber;

  const createSandbox = async () => {
    try {
      setError(undefined);
      setProvisioning(true);
      const response = await fetch('http://localhost:3000/create-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webSessionId: `web-${Date.now()}` }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to create sandbox');
        return;
      }
      setSandbox({ id: data.id, apiUrl: data.apiUrl, token: data.token });
      pushLog('Xcode sandbox ready', data.apiUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setProvisioning(false);
    }
  };

  const stopSandbox = async () => {
    if (!sandbox) return;
    try {
      setError(undefined);
      setStopping(true);
      install.stopRelay();
      const response = await fetch('http://localhost:3000/stop-sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: sandbox.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || 'Failed to stop sandbox');
        return;
      }
      setSandbox(undefined);
      setSigningAssets(undefined);
      build.reset();
      pushLog('Sandbox stopped');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setStopping(false);
    }
  };

  const pickDevice = async () => {
    setError(undefined);
    await install.requestUSBAccess();
  };

  const pairDevice = async () => {
    setError(undefined);
    await install.pairBrowser();
  };

  const prepareSigning = async () => {
    if (!certificateFile || !provisioningProfileFile) {
      setError('Select a .p12 certificate and a .mobileprovision profile first.');
      return;
    }
    try {
      setError(undefined);
      setSigning(true);
      const assets = await importSigningAssetsFromFiles({
        certificateFile,
        provisioningProfileFile,
        certificatePassword: certificatePassword || undefined,
        bundleId: bundleId.trim() || undefined,
        deviceUDID,
        signingMode: 'development',
      });
      setSigningAssets(assets);
      pushLog('Signing assets ready', assets.bundleID);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare signing assets');
    } finally {
      setSigning(false);
    }
  };

  const startBuild = async () => {
    setError(undefined);
    pushLog('Build started');
    await build.startBuild();
  };

  const startInstall = async () => {
    setError(undefined);
    await install.startInstallation();
  };

  const steps = useMemo(
    () => [
      { label: 'Pair iPhone', done: install.hasPairRecord, active: !!install.device },
      { label: 'Sign', done: !!signingAssets, active: install.hasPairRecord },
      { label: 'Build', done: build.status === 'succeeded', active: !!signingAssets },
      { label: 'Install', done: false, active: install.canInstall && build.status === 'succeeded' },
    ],
    [install.device, install.hasPairRecord, install.canInstall, signingAssets, build.status],
  );

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Left sidebar */}
      <div
        style={{
          width: '360px',
          padding: '24px',
          backgroundColor: '#f8f9fa',
          borderRight: '1px solid #e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          gap: '18px',
          boxSizing: 'border-box',
          overflowY: 'auto',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Limrun Device Install</h1>

        {/* Step 0: sandbox */}
        <Section title="1. Build sandbox">
          {!sandbox ?
            <button style={primaryButton(provisioning)} onClick={createSandbox} disabled={provisioning}>
              {provisioning ? 'Provisioning...' : 'Create Xcode sandbox'}
            </button>
          : <>
              <div style={infoBox}>
                Sandbox <code>{sandbox.id}</code> ready.
              </div>
              <button style={dangerButton(stopping)} onClick={stopSandbox} disabled={stopping}>
                {stopping ? 'Stopping...' : 'Stop sandbox'}
              </button>
            </>
          }
        </Section>

        {sandbox && (
          <>
            {/* Step 1: pair */}
            <Section title="2. Pair iPhone">
              <button style={secondaryButton(install.busyAction === 'usb')} onClick={pickDevice}>
                {install.device ? `Selected: ${install.device.hello.productName}` : 'Select iPhone (WebUSB)'}
              </button>
              <button
                style={secondaryButton(!install.canPair)}
                onClick={pairDevice}
                disabled={!install.canPair}
              >
                {install.busyAction === 'pair' ? 'Pairing...' : 'Pair (tap Trust on device)'}
              </button>
              {install.hasPairRecord && <div style={infoBox}>Paired. Pair record stored in this browser.</div>}
              {install.pairConfirmationRequired && (
                <div style={warnBox}>Unlock the iPhone, tap Trust, then pair again.</div>
              )}
            </Section>

            {/* Step 2: signing */}
            <Section title="3. Signing assets">
              <label style={labelStyle}>Bundle ID</label>
              <input
                style={inputStyle}
                placeholder="com.example.MyApp"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
              />
              <label style={labelStyle}>Certificate (.p12)</label>
              <input
                type="file"
                accept=".p12,application/x-pkcs12"
                onChange={(e) => setCertificateFile(e.currentTarget.files?.[0])}
              />
              <label style={labelStyle}>Certificate password</label>
              <input
                style={inputStyle}
                type="password"
                value={certificatePassword}
                onChange={(e) => setCertificatePassword(e.target.value)}
              />
              <label style={labelStyle}>Provisioning profile (.mobileprovision)</label>
              <input
                type="file"
                accept=".mobileprovision"
                onChange={(e) => setProvisioningProfileFile(e.currentTarget.files?.[0])}
              />
              <button style={secondaryButton(signing)} onClick={prepareSigning} disabled={signing}>
                {signing ? 'Preparing...' : 'Prepare signing assets'}
              </button>
              {signingAssets && <div style={infoBox}>Signing assets ready for {signingAssets.bundleID}.</div>}
            </Section>

            {/* Step 3: build */}
            <Section title="4. Build">
              <button
                style={primaryButton(!signingAssets || build.status === 'running' || build.status === 'queued')}
                onClick={startBuild}
                disabled={!signingAssets || build.status === 'running' || build.status === 'queued'}
              >
                {build.status === 'running' || build.status === 'queued' ?
                  `Building (${build.status})...`
                : 'Build signed IPA'}
              </button>
              <div style={infoBox}>Build status: {build.status}</div>
            </Section>

            {/* Step 4: install */}
            <Section title="5. Install">
              <button
                style={primaryButton(!install.canInstall || build.status !== 'succeeded')}
                onClick={startInstall}
                disabled={!install.canInstall || build.status !== 'succeeded'}
              >
                {install.busyAction === 'install' ? 'Installing...' : 'Install onto iPhone'}
              </button>
            </Section>
          </>
        )}

        {(error || install.error || build.error) && (
          <div style={errorBox}>{error || install.error || build.error}</div>
        )}
      </div>

      {/* Main area: progress + logs */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '24px', minWidth: 0 }}>
        <Stepper steps={steps} />

        <div style={{ display: 'flex', gap: '20px', flex: 1, minHeight: 0 }}>
          <LogPanel title="Build log">
            {build.logs.length === 0 ?
              <span style={{ color: '#999' }}>No build output yet.</span>
            : build.logs.map((line, i) => (
                <div key={i} style={{ color: line.type === 'stderr' ? '#c33' : '#222' }}>
                  {line.data}
                </div>
              ))
            }
          </LogPanel>

          <LogPanel title="Activity">
            {log.length === 0 ?
              <span style={{ color: '#999' }}>Nothing yet.</span>
            : log.map((entry, i) => (
                <div key={i}>
                  <span style={{ color: '#999' }}>{entry.at} </span>
                  {entry.message}
                  {entry.detail ? <span style={{ color: '#666' }}> — {entry.detail}</span> : null}
                </div>
              ))
            }
          </LogPanel>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#444' }}>{title}</div>
      {children}
    </div>
  );
}

function Stepper({ steps }: { steps: { label: string; done: boolean; active: boolean }[] }) {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
      {steps.map((step) => (
        <div
          key={step.label}
          style={{
            padding: '8px 14px',
            borderRadius: '999px',
            fontSize: '13px',
            fontWeight: 500,
            backgroundColor: step.done ? '#e8f5e9' : step.active ? '#e3f2fd' : '#f0f0f0',
            color: step.done ? '#2e7d32' : step.active ? '#1565c0' : '#999',
            border: `1px solid ${step.done ? '#a5d6a7' : step.active ? '#90caf9' : '#e0e0e0'}`,
          }}
        >
          {step.done ? '✓ ' : ''}
          {step.label}
        </div>
      ))}
    </div>
  );
}

function LogPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#444', marginBottom: '8px' }}>{title}</div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          backgroundColor: '#0d1117',
          color: '#c9d1d9',
          borderRadius: '8px',
          padding: '12px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: '13px', fontWeight: 500, color: '#444' };

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '14px',
  boxSizing: 'border-box',
};

const infoBox: React.CSSProperties = {
  padding: '10px',
  backgroundColor: '#e8f5e9',
  color: '#2e7d32',
  borderRadius: '6px',
  fontSize: '13px',
};

const warnBox: React.CSSProperties = {
  padding: '10px',
  backgroundColor: '#fff8e1',
  color: '#8a6d00',
  borderRadius: '6px',
  fontSize: '13px',
};

const errorBox: React.CSSProperties = {
  padding: '12px',
  backgroundColor: '#fee',
  color: '#c33',
  borderRadius: '6px',
  fontSize: '13px',
};

function baseButton(disabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    padding: '12px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background-color 0.2s',
  };
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#0066ff' };
}

function secondaryButton(disabled: boolean): React.CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#444' };
}

function dangerButton(disabled: boolean): React.CSSProperties {
  return { ...baseButton(disabled), backgroundColor: disabled ? '#ccc' : '#dc3545' };
}

export default App;
