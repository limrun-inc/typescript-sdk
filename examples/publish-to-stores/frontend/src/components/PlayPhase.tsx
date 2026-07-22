// The Android wizard, mirroring the iOS structure: Connect signs into
// Google, verifies the app exists on Play Console (creating it there is
// the one step Google reserves for humans, so the wizard waits and
// detects), and makes sure the upload keystore is in the secret store.
// Publish then runs the remote signed build + publish in one stream.
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
  const [projectPath, setProjectPath] = useState('');
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
  const canSave = !saving && keystoreFile && keystorePassword && keyAlias;
  const canPublish = play.connected && !running && projectPath.trim() !== '';

  return (
    <>
      <Section title="1. Connect">
        {!play.isSignedIn ?
          <>
            <p style={hintText}>
              Connect signs into Google and verifies the app on Play Console. The signed-in account needs
              release permission for the app; nothing is stored, the session lives in this tab.
            </p>
            <button
              style={primaryButton(play.signingIn)}
              disabled={play.signingIn}
              onClick={() => void play.signIn().then((token) => token && void play.verifyPackage())}
            >
              {play.signingIn ? 'Signing in…' : 'Sign in with Google'}
            </button>
          </>
        : <>
            <div style={infoBox}>Signed in with Google.</div>
            <label style={labelStyle}>App to publish (package name)</label>
            <input
              style={inputStyle}
              value={play.packageName}
              onChange={(event) => play.setPackageName(event.target.value)}
              onBlur={() => void play.verifyPackage()}
              placeholder="com.example.app"
            />
            {play.packageState.status === 'checking' && <p style={hintText}>Checking Play Console…</p>}
            {play.packageState.status === 'unchecked' && play.packageName.trim() !== '' && (
              <button style={secondaryButton(false)} onClick={() => void play.verifyPackage()}>
                Check the app on Play Console
              </button>
            )}
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
            <label style={labelStyle}>Project path (on the backend host)</label>
            <input
              style={inputStyle}
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/path/to/MyAndroidApp"
            />
            {!projectPath.trim() && <p style={hintText}>Enter the project path to enable publishing.</p>}
            <button
              style={primaryButton(!canPublish)}
              disabled={!canPublish}
              onClick={() => void play.publish({ projectPath: projectPath.trim() })}
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
