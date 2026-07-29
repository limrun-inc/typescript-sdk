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

export function ConnectPhase({ connect }: { connect: ConnectController }) {
  if (connect.connection) {
    return (
      <Section title="1. Apple setup">
        <div style={infoBox}>
          Team {connect.connection.teamId}, bundle ID {connect.connection.bundleId}.
        </div>
        {connect.deviceEnrollment.status === 'needs-login' && (
          <>
            <div style={warnBox}>{connect.deviceEnrollment.note}</div>
            {!connect.loggedIn ?
              <AppleLoginForm connect={connect} />
            : <div style={infoBox}>Apple reauthentication is ready. Prepare the device again below.</div>}
          </>
        )}
        <button style={secondaryButton(false)} onClick={connect.disconnect}>
          Disconnect and start over
        </button>
      </Section>
    );
  }

  return (
    <Section title="1. Apple setup">
      {!connect.loggedIn ?
        <>
          <p style={hintText}>
            Sign in through Limrun&apos;s Apple relay, choose a team, and ensure the app&apos;s bundle ID.
            Credentials are created only after a target iPhone and installation method are selected.
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
          <p style={hintText}>Used to label a new bundle ID, the OTA page, and the registered iPhone.</p>
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
