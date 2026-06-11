import type { SigningController, CertificateChoice, ProfileChoice } from '../hooks/useSigning';
import { appIdBundleId, appIdIdentifier, appleTeamSelectionId, stringField } from '../lib/apple';
import { inputStyle, labelStyle, multiSelectStyle, primaryButton, secondaryButton } from '../theme';

/**
 * Signing option A — sign in with an Apple ID and let Limrun create the
 * certificate + provisioning profile. The Apple password never leaves the
 * browser; only SRP proof material is sent to the relay.
 *
 * The flow is: sign in → (2FA) → pick a team → pick/create a Bundle ID resource
 * → register the device → choose cert/profile → Prepare. Each control maps to a
 * handler on the signing controller.
 */
export function AppleSigningPanel({ signing }: { signing: SigningController }) {
  const { appleLogin, resources } = signing;

  return (
    <>
      <label style={labelStyle}>Apple ID</label>
      <input
        style={inputStyle}
        type="email"
        autoComplete="username"
        placeholder="you@example.com"
        value={signing.appleAccount}
        onChange={(e) => signing.setAppleAccount(e.target.value)}
      />
      <label style={labelStyle}>Apple ID password</label>
      <input
        style={inputStyle}
        type="password"
        autoComplete="current-password"
        value={signing.applePassword}
        onChange={(e) => signing.setApplePassword(e.target.value)}
      />
      <button
        style={secondaryButton(!signing.appleAccount || !signing.applePassword || signing.busy === 'login')}
        onClick={() => void signing.signInWithApple()}
        disabled={!signing.appleAccount || !signing.applePassword || signing.busy === 'login'}
      >
        {signing.busy === 'login' ? 'Signing in...' : `Sign in (${appleLogin.status})`}
      </button>

      {appleLogin.status === 'two-factor-required' && (
        <>
          <label style={labelStyle}>Two-factor code</label>
          <input
            style={inputStyle}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={signing.twoFactorCode}
            onChange={(e) => signing.setTwoFactorCode(e.target.value)}
          />
          <button
            style={secondaryButton(!signing.twoFactorCode || signing.busy === '2fa')}
            onClick={() => void signing.submitTwoFactor()}
            disabled={!signing.twoFactorCode || signing.busy === '2fa'}
          >
            {signing.busy === '2fa' ? 'Verifying...' : 'Submit code'}
          </button>
        </>
      )}

      {appleLogin.session && (
        <>
          <label style={labelStyle}>Team</label>
          <select
            style={inputStyle}
            value={signing.selectedTeamId}
            disabled={resources.teams.length === 0}
            onChange={(e) => signing.selectTeam(e.currentTarget.value)}
          >
            <option value="">Sign in to load teams</option>
            {resources.teams.map((team, index) => {
              const value = appleTeamSelectionId(team) ?? `team-${index}`;
              return (
                <option key={value} value={value}>
                  {team.name ?? value}
                </option>
              );
            })}
          </select>

          <label style={labelStyle}>Bundle ID resource</label>
          <select
            style={inputStyle}
            value={signing.selectedAppIdId}
            disabled={resources.appIds.length === 0}
            onChange={(e) => signing.setSelectedAppIdId(e.currentTarget.value)}
          >
            <option value="">Select or create a Bundle ID resource</option>
            {resources.appIds.map((appId, index) => {
              const value = appIdIdentifier(appId) ?? `app-${index}`;
              return (
                <option key={value} value={value}>
                  {appIdBundleId(appId) ?? appId.name ?? value}
                </option>
              );
            })}
          </select>
          <button
            style={secondaryButton(
              !signing.canUseApple || !signing.bundleId.trim() || signing.busy === 'bundle',
            )}
            onClick={() => void signing.createBundleIdResource()}
            disabled={!signing.canUseApple || !signing.bundleId.trim() || signing.busy === 'bundle'}
          >
            {signing.busy === 'bundle' ? 'Creating...' : 'Create bundle ID'}
          </button>

          <label style={labelStyle}>Apple devices</label>
          <select
            multiple
            style={multiSelectStyle}
            value={signing.selectedDeviceIds}
            onChange={(e) =>
              signing.setSelectedDeviceIds(
                Array.from(e.currentTarget.selectedOptions).map((option) => option.value),
              )
            }
          >
            {resources.devices.map((device, index) => {
              const value = device.deviceId ?? `device-${index}`;
              return (
                <option key={value} value={value}>
                  {device.name ?? device.deviceNumber ?? value}
                </option>
              );
            })}
          </select>
          <button
            style={secondaryButton(!signing.canRegisterDevice || signing.busy === 'register-device')}
            onClick={() => void signing.registerDevice()}
            disabled={!signing.canRegisterDevice || signing.busy === 'register-device'}
          >
            {signing.busy === 'register-device' ? 'Registering...' : 'Register selected iPhone'}
          </button>

          <label style={labelStyle}>Certificate</label>
          <select
            style={inputStyle}
            value={signing.certificateChoice}
            onChange={(e) => signing.setCertificateChoice(e.currentTarget.value as CertificateChoice)}
          >
            <option value="stored" disabled={!signing.storedCertificate}>
              Use stored local certificate
            </option>
            <option value="create">Create new certificate</option>
          </select>

          <label style={labelStyle}>Provisioning profile</label>
          <select
            style={inputStyle}
            value={signing.profileChoice}
            onChange={(e) => signing.setProfileChoice(e.currentTarget.value as ProfileChoice)}
          >
            <option value="create">Create new profile</option>
            <option value="existing" disabled={!signing.selectedProfile}>
              Use selected existing profile
            </option>
          </select>
          {signing.profileChoice === 'existing' && (
            <select
              style={inputStyle}
              value={signing.selectedProfileId}
              disabled={resources.profiles.length === 0}
              onChange={(e) => signing.setSelectedProfileId(e.currentTarget.value)}
            >
              <option value="">Select profile</option>
              {resources.profiles.map((profile, index) => {
                const value = stringField(profile, 'provisioningProfileId') ?? `profile-${index}`;
                return (
                  <option key={value} value={value}>
                    {stringField(profile, 'name') ?? value}
                  </option>
                );
              })}
            </select>
          )}

          <button
            style={primaryButton(!signing.canUseApple || signing.preparing)}
            onClick={() => void signing.prepareAppleSigning()}
            disabled={!signing.canUseApple || signing.preparing}
          >
            {signing.preparing ? 'Preparing...' : 'Prepare Apple signing assets'}
          </button>
        </>
      )}
    </>
  );
}
