// The Android wizard: sign into Google, point at the project,
// and the wizard detects the application ID, verifies it on Play Console
// (creating the listing there is the one step Google reserves for humans,
// so the wizard waits and detects), and collects the upload keystore only
// when one is not already stored. Publish is then a single click.
import { useState } from 'react';
import type { PlayController } from '../hooks/usePlay';
import { errorMessage } from '../lib/apple';
import {
  errorBox,
  hintText,
  infoBox,
  inputStyle,
  labelStyle,
  primaryButton,
  secondaryButton,
  warnBox,
} from '../theme';
import { Section } from './Section';

const playConsoleUrl = 'https://play.google.com/console';

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function PlayPhase({ play, onError }: { play: PlayController; onError: (message?: string) => void }) {
  const [keystoreFile, setKeystoreFile] = useState<File>();
  const [keystorePassword, setKeystorePassword] = useState('');
  const [keyAlias, setKeyAlias] = useState('');
  const [keyPassword, setKeyPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const saveKeystore = async () => {
    if (!keystoreFile) return;
    onError(undefined);
    setSaving(true);
    try {
      await play.storeKeystore({
        keystoreBase64: await fileToBase64(keystoreFile),
        keystorePassword,
        keyAlias,
        keyPassword: keyPassword || keystorePassword,
      });
      setKeystorePassword('');
      setKeyPassword('');
    } catch (error) {
      onError(errorMessage(error, 'Could not store the keystore'));
    } finally {
      setSaving(false);
    }
  };

  const running = play.state === 'running';
  const verified = play.packageState.status === 'verified';
  const showPackageField = play.packageName !== '' || play.detectionMiss;
  const canDetect = !play.detecting && play.projectPath.trim() !== '';
  const canSave = !saving && keystoreFile && keystorePassword && keyAlias;
  const canPublish = play.connected && !running;

  return (
    <>
      <Section title="1. Connect">
        {!play.isSignedIn ?
          <>
            <p style={hintText}>
              Connect signs into Google, finds the app in your project, and verifies it on Play Console. The
              signed-in account needs release permission for the app; nothing is stored, the session lives in
              this tab.
            </p>
            <button
              style={primaryButton(play.signingIn)}
              disabled={play.signingIn}
              onClick={() =>
                void play.signIn().then((token) => token && play.projectPath.trim() && void play.detectApp())
              }
            >
              {play.signingIn ? 'Signing in…' : 'Sign in with Google'}
            </button>
          </>
        : <>
            <div style={infoBox}>Signed in with Google.</div>
            <label style={labelStyle}>Project path (on the backend host)</label>
            <input
              style={inputStyle}
              value={play.projectPath}
              onChange={(event) => play.setProjectPath(event.target.value)}
              onBlur={() => canDetect && void play.detectApp()}
              placeholder="/path/to/MyAndroidApp"
            />
            {play.detecting && <p style={hintText}>Inspecting the project…</p>}
            {play.detectionMiss && (
              <div style={warnBox}>
                Could not find an application ID in the project (no expo.android.package or gradle
                applicationId). Enter the package name to publish under; it will be written into the Expo
                config when the publish runs.
              </div>
            )}
            {showPackageField && (
              <>
                <label style={labelStyle}>
                  App to publish{play.detectionMiss ? '' : ' (detected from the project)'}
                </label>
                <input
                  style={inputStyle}
                  value={play.packageName}
                  onChange={(event) => play.setPackageName(event.target.value)}
                  onBlur={() => void play.verifyPackage()}
                  placeholder="com.example.app"
                />
              </>
            )}
            {play.packageState.status === 'checking' && <p style={hintText}>Checking Play Console…</p>}
            {play.packageState.status === 'waiting' && (
              <div style={warnBox}>
                Play Console has no app this account can release under{' '}
                <strong>{play.packageName.trim()}</strong>:{' '}
                <a href={`${playConsoleUrl}/`} target="_blank" rel="noreferrer">
                  create the app in Play Console
                </a>{' '}
                with exactly this package name (Google does not allow creating it via API). Checking again
                every few seconds… <br />
                <span style={hintText}>Google said: {play.packageState.message}</span>
              </div>
            )}
            {verified && <div style={infoBox}>App found on Play Console; this account can release it.</div>}
            {verified &&
              (play.keystoreStored ?
                <div style={infoBox}>Upload keystore is in the secret store.</div>
              : <>
                  <p style={hintText}>
                    No upload keystore stored for this app yet. Import the keystore that signs its Play
                    uploads.
                  </p>
                  <label style={labelStyle}>Upload keystore (.jks / .p12)</label>
                  <input
                    style={inputStyle}
                    type="file"
                    onChange={(event) => setKeystoreFile(event.target.files?.[0])}
                  />
                  <label style={labelStyle}>Keystore password</label>
                  <input
                    style={inputStyle}
                    type="password"
                    value={keystorePassword}
                    onChange={(event) => setKeystorePassword(event.target.value)}
                  />
                  <label style={labelStyle}>Key alias</label>
                  <input
                    style={inputStyle}
                    value={keyAlias}
                    onChange={(event) => setKeyAlias(event.target.value)}
                  />
                  <label style={labelStyle}>Key password (empty to reuse the keystore password)</label>
                  <input
                    style={inputStyle}
                    type="password"
                    value={keyPassword}
                    onChange={(event) => setKeyPassword(event.target.value)}
                  />
                  <button
                    style={secondaryButton(!canSave)}
                    disabled={!canSave}
                    onClick={() => void saveKeystore()}
                  >
                    {saving ? 'Storing…' : 'Store keystore'}
                  </button>
                </>)}
          </>
        }
      </Section>
      <Section title="2. Publish">
        {!play.connected ?
          <p style={hintText}>Locked. Complete the Connect phase first.</p>
        : <>
            <p style={hintText}>
              Builds {play.projectPath.trim()} remotely, signs the AAB with the stored upload key, and
              publishes it to the internal track.
            </p>
            <button
              style={primaryButton(!canPublish)}
              disabled={!canPublish}
              onClick={() => void play.publish()}
            >
              {running ? 'Publishing…' : `Publish ${play.packageName.trim()} to the internal track`}
            </button>
            {play.state === 'succeeded' && (
              <div style={infoBox}>
                Published to the internal track.{' '}
                <a href={playConsoleUrl} target="_blank" rel="noreferrer">
                  Open Play Console
                </a>{' '}
                to see the release.
              </div>
            )}
            {play.state === 'failed' && (
              <div style={errorBox}>
                Publish failed{play.exitCode !== undefined ? ` (exit code ${play.exitCode})` : ''}. See the
                build log.
              </div>
            )}
          </>
        }
      </Section>
    </>
  );
}
