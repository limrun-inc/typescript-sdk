import type { SigningController } from '../hooks/useSigning';
import { infoBox, inputStyle, labelStyle, tabButton, tabRow } from '../theme';
import { Section } from './Section';
import { AppleSigningPanel } from './AppleSigningPanel';
import { UploadSigningPanel } from './UploadSigningPanel';

/**
 * Step 3 — produce the `StoredSigningAssets` used by the build. The user picks
 * one of two flows via the tabs; both end with assets stored in IndexedDB.
 */
export function SigningStep({ signing }: { signing: SigningController }) {
  return (
    <Section title="3. Signing assets">
      <div style={tabRow}>
        <button style={tabButton(signing.source === 'apple')} onClick={() => signing.setSource('apple')}>
          Apple ID
        </button>
        <button style={tabButton(signing.source === 'upload')} onClick={() => signing.setSource('upload')}>
          Upload files
        </button>
      </div>

      <label style={labelStyle}>Bundle ID</label>
      <input
        style={inputStyle}
        placeholder="com.example.MyApp"
        value={signing.bundleId}
        onChange={(e) => signing.setBundleId(e.target.value)}
      />

      {signing.source === 'apple' ?
        <AppleSigningPanel signing={signing} />
      : <UploadSigningPanel signing={signing} />}

      {signing.signingAssets && (
        <div style={infoBox}>Signing assets ready for {signing.signingAssets.bundleID}.</div>
      )}
    </Section>
  );
}
