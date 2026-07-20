import { useState } from 'react';
import type { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
import { hintText, inputStyle, labelStyle, primaryButton } from '../theme';
import { Section } from './Section';

type Props = {
  install: ReturnType<typeof useDeviceInstallRelay>;
  onError: (message?: string) => void;
};

/**
 * Step 2 — install a signed IPA onto the paired iPhone over the WebUSB relay.
 * The registry downloads the artifact — an asset in your organization's
 * storage, or any HTTPS URL — and streams it onto the device. Progress goes
 * through the relay's `log` callback into the Activity panel.
 *
 * Producing the signed IPA is a backend concern: build it with `@limrun/api`
 * and upload it as an asset (see examples/publish-to-stores for the full
 * signing + build flow).
 */
export function InstallStep({ install, onError }: Props) {
  const [assetName, setAssetName] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const source =
    assetName.trim() ? { assetName: assetName.trim() }
    : downloadUrl.trim() ? { downloadUrl: downloadUrl.trim() }
    : undefined;
  const ready = install.canInstall && !!source;

  return (
    <Section title="Install">
      <label style={labelStyle}>Asset name</label>
      <input
        style={inputStyle}
        placeholder="my-app.ipa"
        value={assetName}
        onChange={(e) => setAssetName(e.target.value)}
      />
      <label style={labelStyle}>IPA download URL (used when asset name is empty)</label>
      <input
        style={inputStyle}
        placeholder="https://example.com/app.ipa"
        value={downloadUrl}
        onChange={(e) => setDownloadUrl(e.target.value)}
      />
      <button
        style={primaryButton(!ready)}
        onClick={() => {
          onError(undefined);
          if (source) void install.startInstallation(source);
        }}
        disabled={!ready}
      >
        {install.busyAction === 'install' ? 'Installing...' : 'Install onto iPhone'}
      </button>
      <div style={hintText}>
        The IPA must be signed with a development profile that includes the paired iPhone's UDID, or the
        install is rejected with <code>ApplicationVerificationFailed</code>.
      </div>
    </Section>
  );
}
