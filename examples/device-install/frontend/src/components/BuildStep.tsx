import type { useDeviceBuild } from '@limrun/ui/device-build/react';
import { hintText, infoBox, primaryButton } from '../theme';
import { Section } from './Section';

type Props = {
  build: ReturnType<typeof useDeviceBuild>;
  sandboxId: string;
  signingReady: boolean;
  log: (message: string, detail?: unknown) => void;
  onError: (message?: string) => void;
};

/**
 * Step 4 — trigger a signed `iphoneos` build on the sandbox. Logs stream into
 * the Build log panel; `status === 'succeeded'` gates the install step.
 */
export function BuildStep({ build, sandboxId, signingReady, log, onError }: Props) {
  const busy = build.status === 'running' || build.status === 'queued';

  return (
    <Section title="Build signed IPA">
      <div style={hintText}>
        Make sure you ran <code>lim xcode sync . --id {sandboxId}</code> first — builds run against the synced
        source.
      </div>
      <button
        style={primaryButton(!signingReady || busy)}
        onClick={() => {
          onError(undefined);
          log('Build started');
          void build.startBuild();
        }}
        disabled={!signingReady || busy}
      >
        {busy ? `Building (${build.status})...` : 'Build signed IPA'}
      </button>
      <div style={infoBox}>Build status: {build.status}</div>
    </Section>
  );
}
