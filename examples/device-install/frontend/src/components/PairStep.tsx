import type { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { infoBox, secondaryButton, warnBox } from '../theme';
import { Section } from './Section';

type Props = {
  install: ReturnType<typeof useDeviceInstallRelay>;
  onError: (message?: string) => void;
};

/**
 * Step 2 — pair the iPhone over WebUSB. `requestUSBAccess` opens Chrome's
 * device picker; `pairBrowser` runs the handshake and stores the pair record in
 * IndexedDB, so the user only taps Trust once per device.
 */
export function PairStep({ install, onError }: Props) {
  return (
    <Section title="Pair iPhone">
      <button
        style={secondaryButton(install.busyAction === 'usb')}
        onClick={() => {
          onError(undefined);
          void install.requestUSBAccess();
        }}
      >
        {install.device ? `Selected: ${install.device.hello.productName}` : 'Select iPhone (WebUSB)'}
      </button>
      <button
        style={secondaryButton(!install.canPair)}
        onClick={() => {
          onError(undefined);
          void install.pairBrowser();
        }}
        disabled={!install.canPair}
      >
        {install.busyAction === 'pair' ? 'Pairing...' : 'Pair (tap Trust on device)'}
      </button>
      {install.hasPairRecord && <div style={infoBox}>Paired. Pair record stored in this browser.</div>}
      {install.pairConfirmationRequired && (
        <div style={warnBox}>Unlock the iPhone, tap Trust, then pair again.</div>
      )}
    </Section>
  );
}
