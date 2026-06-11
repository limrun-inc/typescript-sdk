import type { SigningController } from '../hooks/useSigning';
import { inputStyle, labelStyle, secondaryButton } from '../theme';

/**
 * Signing option B — upload a `.p12` + `.mobileprovision`. The profile must
 * cover the app's bundle ID and include the paired device's UDID.
 */
export function UploadSigningPanel({ signing }: { signing: SigningController }) {
  return (
    <>
      <label style={labelStyle}>Certificate (.p12)</label>
      <input
        type="file"
        accept=".p12,application/x-pkcs12"
        onChange={(e) => signing.setCertificateFile(e.currentTarget.files?.[0])}
      />
      <label style={labelStyle}>Certificate password</label>
      <input
        style={inputStyle}
        type="password"
        value={signing.certificatePassword}
        onChange={(e) => signing.setCertificatePassword(e.target.value)}
      />
      <label style={labelStyle}>Provisioning profile (.mobileprovision)</label>
      <input
        type="file"
        accept=".mobileprovision"
        onChange={(e) => signing.setProvisioningProfileFile(e.currentTarget.files?.[0])}
      />
      <button
        style={secondaryButton(signing.preparing)}
        onClick={() => void signing.prepareUploadSigning()}
        disabled={signing.preparing}
      >
        {signing.preparing ? 'Preparing...' : 'Prepare signing assets'}
      </button>
    </>
  );
}
