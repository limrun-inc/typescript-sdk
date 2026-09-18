import { GOOGLE_PLAY_CONSOLE_SCOPE } from '../config';
import type { PlayController } from '../hooks/usePlay';
import { hintText, infoBox, inputStyle, labelStyle, primaryButton, warnBox } from '../theme';

export function CreatePlayApp({ play }: { play: PlayController }) {
  const disabled =
    !GOOGLE_PLAY_CONSOLE_SCOPE ||
    play.creation === 'running' ||
    play.creation === 'unknown' ||
    (play.detecting && play.packageState.status !== 'waiting');
  const app = play.createdApp;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void play.createApp(
          app ? undefined : (
            {
              developerId: String(data.get('developerId')),
              title: String(data.get('title')),
              defaultLanguage: String(data.get('language')),
              appMeetsGuidelines: data.has('policies'),
              usExportCompliant: data.has('export'),
            }
          ),
        );
      }}
    >
      <p style={warnBox}>
        Experimental: requires Google approval for <code>play_console</code> or <code>playdeveloperapp</code>.
        Set <code>GOOGLE_PLAY_CONSOLE_SCOPE</code> in <code>src/config.ts</code> to your approved scope.
        Ordinary <code>androidpublisher</code> access is insufficient. Approved-client OAuth is not yet
        verified.
      </p>
      {play.creation === 'unknown' ?
        <p style={warnBox}>
          The app may have been created. Check Play Console and recover it before reloading or retrying.
        </p>
      : app ?
        <p style={infoBox}>
          App created: {app.appId}.{' '}
          {play.creation === 'ready' ? 'Play App Signing is enrolled.' : 'Signing enrollment is pending.'}
        </p>
      : <fieldset disabled={disabled} style={{ border: 0, padding: 0 }}>
          <p style={hintText}>Create a free Android app with a Google-managed distribution signing key.</p>
          <label style={labelStyle}>
            Developer account ID
            <input style={inputStyle} name="developerId" required pattern="[0-9]+" />
          </label>
          <label style={labelStyle}>
            App title
            <input style={inputStyle} name="title" required pattern=".*\S.*" />
          </label>
          <label style={labelStyle}>
            Default language
            <input style={inputStyle} name="language" defaultValue="en-US" required pattern=".*\S.*" />
          </label>
          <label style={labelStyle}>
            <input type="checkbox" name="policies" required /> I confirm this app meets the Google Play
            Developer Program Policies.
          </label>
          <label style={labelStyle}>
            <input type="checkbox" name="export" required /> I confirm this app complies with US export laws.
          </label>
        </fieldset>
      }
      {play.creation !== 'ready' && (
        <button style={primaryButton(disabled)} disabled={disabled}>
          {play.creation === 'running' ?
            'Setting up app…'
          : app ?
            'Retry signing enrollment'
          : 'Create app'}
        </button>
      )}
    </form>
  );
}
