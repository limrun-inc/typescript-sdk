import { useMemo, useState } from 'react';
import { useDeviceBuild } from '@limrun/ui/device-build/react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { useActivityLog } from './hooks/useActivityLog';
import { useSigning } from './hooks/useSigning';
import * as sandboxApi from './lib/sandboxApi';
import { errorMessage } from './lib/apple';
import type { Sandbox } from './types';
import { errorBox, layout } from './theme';
import { PhaseProgress } from './components/PhaseProgress';
import { Phase } from './components/Phase';
import { LogPanel } from './components/LogPanel';
import { SandboxStep } from './components/SandboxStep';
import { PairStep } from './components/PairStep';
import { SigningStep } from './components/SigningStep';
import { BuildStep } from './components/BuildStep';
import { InstallStep } from './components/InstallStep';

/**
 * Top-level orchestrator. It wires the three Limrun hooks together and splits
 * the work into the two tasks users actually have:
 *
 *   Phase 1 — Build a signed artifact:  sign → build  (on the sandbox)
 *   Phase 2 — Install to a device:       pair → install
 *
 * The phases are deliberately separate: producing the artifact and installing
 * it are often done at different times. They join at install, which needs both
 * Phase 1's succeeded build and a paired device. The sandbox is the shared
 * infrastructure that hosts the build and the WebUSB install relay.
 *
 * Each step lives in its own component under `components/`, and the signing
 * logic lives in `hooks/useSigning.ts`. Read those for the details; this file
 * is just the glue.
 */
function App() {
  const activity = useActivityLog();
  const [sandbox, setSandbox] = useState<Sandbox>();
  const [provisioning, setProvisioning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();

  const apiUrl = sandbox?.apiUrl;
  const token = sandbox?.token;

  // The three building blocks from `@limrun/ui`, all pointed at the sandbox.
  const install = useDeviceInstallRelay({ apiUrl, token, log: activity.push });
  const signing = useSigning({
    apiUrl,
    token,
    deviceUDID: install.device?.hello.serialNumber,
    deviceName: install.device?.hello.productName,
    log: activity.push,
    onError: setError,
  });
  const build = useDeviceBuild({ apiUrl, token, signingAssets: signing.signingAssets });

  async function createSandbox() {
    setError(undefined);
    setProvisioning(true);
    try {
      const next = await sandboxApi.createSandbox();
      setSandbox(next);
      activity.push('Xcode sandbox ready', next.apiUrl);
      activity.push('Next: sync your project into the sandbox', `lim xcode sync . --id ${next.id}`);
    } catch (err) {
      setError(errorMessage(err, 'An unknown error occurred'));
    } finally {
      setProvisioning(false);
    }
  }

  async function stopSandbox() {
    if (!sandbox) return;
    setError(undefined);
    setStopping(true);
    try {
      install.stopRelay();
      await sandboxApi.stopSandbox(sandbox.id);
      setSandbox(undefined);
      signing.reset();
      build.reset();
      activity.push('Sandbox stopped');
    } catch (err) {
      setError(errorMessage(err, 'An unknown error occurred'));
    } finally {
      setStopping(false);
    }
  }

  const phases = useMemo(
    () => [
      {
        title: 'Phase 1 · Build artifact',
        steps: [
          { label: 'Sign', done: !!signing.signingAssets, active: !!sandbox },
          { label: 'Build', done: build.status === 'succeeded', active: !!signing.signingAssets },
        ],
      },
      {
        title: 'Phase 2 · Install',
        steps: [
          { label: 'Pair iPhone', done: install.hasPairRecord, active: !!install.device },
          {
            label: 'Install',
            done: false,
            active: install.canInstall && build.status === 'succeeded',
          },
        ],
      },
    ],
    [sandbox, install.device, install.hasPairRecord, install.canInstall, signing.signingAssets, build.status],
  );

  return (
    <div style={layout.page}>
      <aside style={layout.sidebar}>
        <h1 style={layout.title}>Limrun Device Install</h1>

        <SandboxStep
          sandbox={sandbox}
          provisioning={provisioning}
          stopping={stopping}
          onCreate={() => void createSandbox()}
          onStop={() => void stopSandbox()}
        />

        {sandbox && (
          <>
            <Phase
              index={1}
              title="Build a signed artifact"
              subtitle="Prepare signing assets and build a signed IPA on the sandbox. No device needed yet."
            >
              <SigningStep signing={signing} />
              <BuildStep
                build={build}
                sandboxId={sandbox.id}
                signingReady={!!signing.signingAssets}
                log={activity.push}
                onError={setError}
              />
            </Phase>

            <Phase
              index={2}
              title="Install to a device"
              subtitle="Pair an iPhone and install the artifact from Phase 1 over WebUSB."
            >
              <PairStep install={install} onError={setError} />
              <InstallStep install={install} build={build} onError={setError} />
            </Phase>
          </>
        )}

        {(error || install.error || build.error) && (
          <div style={errorBox}>{error || install.error || build.error}</div>
        )}
      </aside>

      <main style={layout.main}>
        <PhaseProgress phases={phases} />

        <div style={layout.panels}>
          <LogPanel title="Build log" scrollKey={build.logs.length}>
            {build.logs.length === 0 ?
              <span style={{ color: '#8b949e' }}>No build output yet.</span>
            : build.logs.map((line, i) => (
                <div key={i} style={{ color: line.type === 'stderr' ? '#ff7b72' : '#c9d1d9' }}>
                  {line.data}
                </div>
              ))
            }
          </LogPanel>

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
