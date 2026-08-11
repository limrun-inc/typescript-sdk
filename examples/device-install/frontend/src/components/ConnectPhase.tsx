import type { ConnectController } from '../hooks/useConnect';
import { NEW_BUNDLE_ID } from '../hooks/useConnect';
import { hintText, infoBox, inputStyle, labelStyle, primaryButton, secondaryButton, warnBox } from '../theme';
import { Section } from './Section';

function AppleLoginForm({ connect }: { connect: ConnectController }) {
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect.signIn();
        }}
      >
        <label style={labelStyle}>Apple ID</label>
        <input
          style={inputStyle}
          type="email"
          autoComplete="username"
          value={connect.appleAccount}
          onChange={(event) => connect.setAppleAccount(event.target.value)}
          placeholder="developer@example.com"
        />
        <label style={labelStyle}>Password</label>
        <input
          style={inputStyle}
          type="password"
          autoComplete="current-password"
          value={connect.applePassword}
          onChange={(event) => connect.setApplePassword(event.target.value)}
        />
        <button
          type="submit"
          style={primaryButton(connect.busy === 'login' || !connect.relayReady)}
          disabled={connect.busy === 'login' || !connect.relayReady}
        >
          {connect.busy === 'login' ?
            'Signing in…'
          : !connect.relayReady ?
            'Waiting for the backend…'
          : 'Sign in with Apple'}
        </button>
      </form>
      {connect.appleLogin.status === 'two-factor-required' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect.submitTwoFactor();
          }}
        >
          <div style={warnBox}>Enter the verification code sent to your trusted device or phone.</div>
          <input
            style={inputStyle}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={connect.twoFactorCode}
            onChange={(event) => connect.setTwoFactorCode(event.target.value)}
            placeholder="123456"
          />
          <button
            type="submit"
            style={primaryButton(connect.busy === '2fa')}
            disabled={connect.busy === '2fa'}
          >
            {connect.busy === '2fa' ? 'Verifying…' : 'Verify code'}
          </button>
        </form>
      )}
    </>
  );
}

/**
 * Stage 1: ad-hoc signing. With a stored connection the phase starts from
 * the secret store: when the distribution certificate and an ad-hoc profile
 * are already there, it only shows a ready summary. Apple sign-in appears
 * when material is missing or a later stage flagged that it needs a portal
 * session (e.g. registering a new device).
 */
export function ConnectPhase({ connect }: { connect: ConnectController }) {
  if (connect.connection) {
    const needsLogin =
      !connect.loggedIn &&
      (connect.signing.status === 'missing' || connect.deviceEnrollment.status === 'needs-login');
    return (
      <Section title="1. Ad-hoc signing">
        <div style={infoBox}>
          Team {connect.connection.teamId}, bundle ID {connect.connection.bundleId}.
        </div>
        {connect.signing.status === 'checking' && <p style={hintText}>Checking stored signing secrets…</p>}
        {connect.signing.note && (
          <div style={connect.signing.status === 'ready' ? infoBox : warnBox}>{connect.signing.note}</div>
        )}
        {connect.deviceEnrollment.status === 'needs-login' && (
          <div style={warnBox}>{connect.deviceEnrollment.note}</div>
        )}
        {needsLogin && <AppleLoginForm connect={connect} />}
        {connect.loggedIn && connect.signing.status !== 'ready' && (
          <div style={infoBox}>Apple session is ready. Register a device below to create the profile.</div>
        )}
        <button style={secondaryButton(false)} onClick={connect.disconnect}>
          Disconnect and start over
        </button>
      </Section>
    );
  }

  return (
    <Section title="1. Ad-hoc signing">
      {!connect.loggedIn ?
        <>
          <p style={hintText}>
            Sign in through Limrun&apos;s Apple relay, choose a team, and ensure the app&apos;s bundle ID. A
            distribution certificate is created right away; the ad-hoc provisioning profile follows when a
            device is registered.
          </p>
          <AppleLoginForm connect={connect} />
        </>
      : <>
          <label style={labelStyle}>Team</label>
          <select
            style={inputStyle}
            value={connect.selectedTeamId}
            onChange={(event) => connect.selectTeam(event.target.value)}
          >
            {connect.teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.name ? `${team.name} (${team.teamId})` : team.teamId}
              </option>
            ))}
          </select>
          <label style={labelStyle}>Bundle ID</label>
          <select
            style={inputStyle}
            value={connect.bundleIdChoice}
            onChange={(event) => connect.setBundleIdChoice(event.target.value)}
          >
            <option value={NEW_BUNDLE_ID}>Register a new bundle ID…</option>
            {connect.portalAppIds.map((appId) => (
              <option key={appId.bundleId} value={appId.bundleId}>
                {appId.name ? `${appId.bundleId} (${appId.name})` : appId.bundleId}
              </option>
            ))}
          </select>
          {connect.bundleIdsLoading && <p style={hintText}>Loading existing bundle IDs…</p>}
          {connect.bundleIdChoice === NEW_BUNDLE_ID && (
            <input
              style={inputStyle}
              value={connect.bundleId}
              onChange={(event) => connect.setBundleId(event.target.value)}
              placeholder="com.example.myapp"
            />
          )}
          <label style={labelStyle}>App name</label>
          <input
            style={inputStyle}
            value={connect.appName}
            onChange={(event) => connect.setAppName(event.target.value)}
            placeholder="My App"
          />
          <p style={hintText}>Used to label a new bundle ID, the OTA install page, and registered iPhones.</p>
          <button
            style={primaryButton(connect.busy === 'confirm')}
            disabled={connect.busy === 'confirm'}
            onClick={() => void connect.confirm()}
          >
            {connect.busy === 'confirm' ? 'Saving…' : 'Confirm Apple setup'}
          </button>
        </>
      }
    </Section>
  );
}
