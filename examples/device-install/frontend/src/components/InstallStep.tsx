import type { useDeviceBuild } from '@limrun/ui/device-build/react';
import type { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { hintText, primaryButton, warnBox } from '../theme';
import { Section } from './Section';

type Props = {
  install: ReturnType<typeof useDeviceInstallRelay>;
  build: ReturnType<typeof useDeviceBuild>;
  onError: (message?: string) => void;
};

/**
 * Install the signed artifact from Phase 1 onto the paired iPhone over the
 * WebUSB relay. This is the join between the two phases: it needs both a
 * succeeded build (the artifact) and a stored pair record. Progress streams
 * through the relay's `log` callback into the Activity panel.
 */
export function InstallStep({ install, build, onError }: Props) {
  const hasArtifact = build.status === 'succeeded';
  const ready = install.canInstall && hasArtifact;

  return (
    <Section title="Install">
      {!hasArtifact && (
        <div style={warnBox}>Build a signed artifact in Phase 1 first — there's nothing to install yet.</div>
      )}
      <button
        style={primaryButton(!ready)}
        onClick={() => {
          onError(undefined);
          void install.startInstallation();
        }}
        disabled={!ready}
      >
        {install.busyAction === 'install' ? 'Installing...' : 'Install onto iPhone'}
      </button>
      <div style={hintText}>
        The paired device must be included in the provisioning profile used for the build, or the install is
        rejected with <code>ApplicationVerificationFailed</code>.
      </div>
    </Section>
  );
}
