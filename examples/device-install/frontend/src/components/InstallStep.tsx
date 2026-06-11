import type { useDeviceBuild } from '@limrun/ui/device-build/react';
import type { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { primaryButton } from '../theme';
import { Section } from './Section';

type Props = {
  install: ReturnType<typeof useDeviceInstallRelay>;
  build: ReturnType<typeof useDeviceBuild>;
  onError: (message?: string) => void;
};

/**
 * Step 5 — install the latest successful build onto the paired iPhone over the
 * WebUSB relay. Needs both a stored pair record and a succeeded build; progress
 * streams through the relay's `log` callback into the Activity panel.
 */
export function InstallStep({ install, build, onError }: Props) {
  const ready = install.canInstall && build.status === 'succeeded';

  return (
    <Section title="5. Install">
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
    </Section>
  );
}
