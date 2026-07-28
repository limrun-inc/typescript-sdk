// The Connect wizard UI: Apple ID login (password + 2FA), team selection,
// bundle ID / app name inputs, and the action checklist. All behaviour
// lives in useConnect; this component only renders its state.
import {
  CONNECT_ACTIONS,
  NEW_BUNDLE_ID,
  type ConnectController,
  type ActionStatus,
} from '../hooks/useConnect';
import { hintText, infoBox, inputStyle, labelStyle, primaryButton, secondaryButton, warnBox } from '../theme';
import { Section } from './Section';

const statusGlyph: Record<ActionStatus, string> = {
  pending: '·',
  running: '…',
  done: '✓',
  skipped: '−',
  error: '✗',
};

const statusColor: Record<ActionStatus, string> = {
  pending: '#999',
  running: '#0066ff',
  done: '#2e7d32',
  skipped: '#8a6d00',
  error: '#c33',
};

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
        <p style={hintText}>
          Your password never leaves the browser by using Apple's {' '}
          <a
            href="https://en.wikipedia.org/wiki/Secure_Remote_Password_protocol"
            target="_blank"
            rel="noreferrer"
          >
            Secure Remote Password
          </a>{' '}
          protocol.
        </p>
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
      <Section title="1. Connect">
        <div style={infoBox}>
          Connected: team {connect.connection.teamId}, bundle ID {connect.connection.bundleId}. Signing
          material is in the secret store, so this phase is skipped.
        </div>
        <button style={secondaryButton(false)} onClick={connect.disconnect}>
          Disconnect and start over
        </button>
      </Section>
    );
  }

  return (
    <Section title="1. Connect">
      {!connect.loggedIn && (
        <>
          <p style={hintText}>
            Sign in to create or fetch your signing material to be able to interact with Apple Developer
            Services.
          </p>
          <AppleLoginForm connect={connect} />
        </>
      )}

      {connect.loggedIn && (
        <>
          <label style={labelStyle}>Team</label>
          <select
            style={inputStyle}
            value={connect.selectedTeamId}
            onChange={(event) => connect.setSelectedTeamId(event.target.value)}
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
          {connect.bundleIdsLoading && <p style={hintText}>Loading the team's existing bundle IDs…</p>}
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
          <p style={hintText}>
            Used for the bundle ID registration and the App Store Connect app record. It becomes the app's
            name on the App Store.
          </p>

          <label style={labelStyle}>Actions</label>
          {CONNECT_ACTIONS.map((action) => {
            const state = connect.actionStates[action.id];
            return (
              <label
                key={action.id}
                style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '13px' }}
              >
                <input
                  type="checkbox"
                  checked={connect.selectedActions.has(action.id)}
                  disabled={connect.busy === 'confirm'}
                  onChange={() => connect.toggleAction(action.id)}
                />
                <span style={{ flex: 1 }}>
                  <strong>{action.label}</strong>
                  <br />
                  <span style={hintText}>{action.description}</span>
                  {state && (
                    <>
                      <br />
                      <span style={{ color: statusColor[state.status], fontSize: '12px' }}>
                        {statusGlyph[state.status]} {state.status}
                        {state.note ? ` — ${state.note}` : ''}
                      </span>
                    </>
                  )}
                </span>
              </label>
            );
          })}
          <button
            style={primaryButton(connect.busy === 'confirm')}
            disabled={connect.busy === 'confirm'}
            onClick={() => void connect.confirm()}
          >
            {connect.busy === 'confirm' ? 'Connecting…' : 'Confirm and connect'}
          </button>
        </>
      )}
    </Section>
  );
}
