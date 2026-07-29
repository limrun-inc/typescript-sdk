// The Google Play controller, mirroring the iOS split: Connect (Google
// sign-in, package verification against Play, upload keystore in the
// secret store) unlocks Publish (remote signed build + publish, streamed).
// The Google access token lives in memory for the session (~1h) and rides
// each publish request; the Limrun API key never reaches the browser.
import { useRef, useState } from 'react';
import {
  ANDROID_SIGNING_KEY_SECRET_TYPE,
  generateAndroidUploadKeystore,
  loadGoogleIdentityServices,
  requestGoogleAccessToken,
  type SigningSecretStore,
} from '@limrun/play-auth';
import { GOOGLE_OAUTH_CLIENT_ID } from '../config';
import {
  detectAndroidPackage,
  errorMessage,
  fetchPublishStatus,
  sleep,
  startAndroidPublish,
  type PublishStatus,
} from '../lib/backend';
import { probePlayAccess } from '../lib/googlePlay';
import type { PublishState } from './usePublish';

const PACKAGE_STORAGE_KEY = 'publish-to-stores.play.packageName';
const PROJECT_STORAGE_KEY = 'publish-to-stores.play.projectPath';

/** How often to re-probe while waiting for the user to create the app. */
const PACKAGE_POLL_INTERVAL_MS = 5000;
const PUBLISH_POLL_INTERVAL_MS = 3000;

// Warm the sign-in script at module load so the consent popup opens
// synchronously with the click and popup blockers stay quiet.
void loadGoogleIdentityServices().catch(() => undefined);

export type PackageState =
  | { status: 'unchecked' }
  | { status: 'checking' }
  /** App missing or no access yet; polls until the user fixes it in Play Console. */
  | { status: 'waiting'; message: string }
  | { status: 'verified' };

export type PlayController = ReturnType<typeof usePlay>;

export function usePlay({
  secretStore,
  onError,
}: {
  secretStore: SigningSecretStore;
  onError: (message?: string) => void;
}) {
  // --- State ----------------------------------------------------------------
  // The token is read through a ref so actions right after signIn in the
  // same handler see it before React re-renders (console does the same).
  const accessTokenRef = useRef<string | undefined>(undefined);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const [projectPath, setProjectPathState] = useState(() => localStorage.getItem(PROJECT_STORAGE_KEY) ?? '');
  const [packageName, setPackageNameState] = useState(() => localStorage.getItem(PACKAGE_STORAGE_KEY) ?? '');
  const [packageState, setPackageState] = useState<PackageState>({ status: 'unchecked' });
  const [detecting, setDetecting] = useState(false);
  /** Set when detection ran and found nothing; the user types the package. */
  const [detectionMiss, setDetectionMiss] = useState(false);
  // verifyPackage keeps probing inside one async loop; editing the name,
  // re-verifying or signing out bumps this sequence, which retires any
  // older loop the next time it wakes up.
  const probeSeq = useRef(0);

  // Four keystore states on purpose: only a definitive 'absent' may render
  // the generate/import forms, because writing over an EXISTING escrowed
  // upload key silently replaces it and breaks every later upload with an
  // upload-key mismatch. 'unknown' means a check is in flight; 'error'
  // means the check failed and the user must retry it.
  const [keystoreState, setKeystoreState] = useState<'unknown' | 'error' | 'absent' | 'present'>('unknown');
  // One busy slot for both keystore actions: they write the same secret,
  // so running them concurrently must be impossible.
  const [keystoreBusy, setKeystoreBusy] = useState<'generating' | 'saving'>();

  const [state, setState] = useState<PublishState>('idle');
  const [status, setStatus] = useState<PublishStatus>();
  const [publishError, setPublishError] = useState<string>();

  // --- Google session ---------------------------------------------------

  async function signIn() {
    onError(undefined);
    setSigningIn(true);
    try {
      const token = await requestGoogleAccessToken({ clientId: GOOGLE_OAUTH_CLIENT_ID });
      accessTokenRef.current = token;
      setIsSignedIn(true);
      return token;
    } catch (error) {
      onError(errorMessage(error, 'Google sign-in failed'));
      return undefined;
    } finally {
      setSigningIn(false);
    }
  }

  function signOut() {
    probeSeq.current++; // retire any probe loop still waiting on Play
    accessTokenRef.current = undefined;
    setIsSignedIn(false);
    setPackageState({ status: 'unchecked' });
  }

  // --- Project & package detection -----------------------------------------

  function setPackageName(value: string) {
    probeSeq.current++;
    setPackageNameState(value);
    setPackageState({ status: 'unchecked' });
    setKeystoreState('unknown');
  }

  function setProjectPath(value: string) {
    probeSeq.current++;
    setProjectPathState(value);
    setDetectionMiss(false);
    // A different path may hold a different app; the verified state must
    // not carry over to whatever the user points at next.
    setPackageState({ status: 'unchecked' });
  }

  /**
   * Probes Play Console for the package, and — while the app listing does
   * not exist yet (creating it is the one step Google reserves for humans)
   * — keeps re-probing so the wizard moves on by itself the moment the
   * user creates it. Verification also triggers the upload keystore check,
   * the other half of the Connect gate.
   */
  async function verifyPackage(explicitName?: string) {
    const token = accessTokenRef.current;
    const name = (explicitName ?? packageName).trim();
    if (!token || !name) return;
    const seq = ++probeSeq.current;
    setPackageState({ status: 'checking' });
    while (true) {
      const probe = await probePlayAccess(token, name);
      if (seq !== probeSeq.current) return; // superseded by a newer probe
      if (probe.result === 'ok') {
        localStorage.setItem(PACKAGE_STORAGE_KEY, name);
        setPackageState({ status: 'verified' });
        await checkKeystore(name);
        return;
      }
      if (probe.result === 'unauthorized') {
        // The ~1h token expired; the next sign-in click mints a fresh one.
        signOut();
        onError('The Google session expired. Sign in again.');
        return;
      }
      setPackageState({ status: 'waiting', message: probe.message });
      await sleep(PACKAGE_POLL_INTERVAL_MS);
      if (seq !== probeSeq.current) return;
    }
  }

  /**
   * The wizard's entry point: inspect the project on the backend host,
   * prefill the detected application ID, and verify it against Play in one
   * go. A detection miss leaves the package field for the user; the
   * backend fills expo.android.package into app.json at publish time.
   */
  async function detectApp() {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) return;
    probeSeq.current++;
    onError(undefined);
    setDetecting(true);
    setDetectionMiss(false);
    try {
      const detected = await detectAndroidPackage(trimmedPath);
      localStorage.setItem(PROJECT_STORAGE_KEY, trimmedPath);
      if (detected) {
        setPackageNameState(detected);
        await verifyPackage(detected);
      } else {
        setDetectionMiss(true);
        setPackageNameState('');
        setPackageState({ status: 'unchecked' });
      }
    } catch (error) {
      onError(errorMessage(error, 'Could not inspect the project'));
    } finally {
      setDetecting(false);
    }
  }

  // --- Upload keystore ----------------------------------------------------

  async function checkKeystore(name = packageName.trim()) {
    setKeystoreState('unknown');
    try {
      const secret = await secretStore.get(ANDROID_SIGNING_KEY_SECRET_TYPE, `${name}/UPLOAD`);
      setKeystoreState(secret !== undefined ? 'present' : 'absent');
    } catch {
      setKeystoreState('error');
    }
  }

  /**
   * Escrows an upload keystore under the package. Re-checks the store
   * right before writing, for the imported and the generated key alike:
   * overwriting an existing upload key would break every later upload,
   * so a racing or previously failed check must abort.
   */
  async function escrowKeystore(data: {
    keystoreBase64: string;
    keystorePassword: string;
    keyAlias: string;
    keyPassword: string;
  }) {
    const name = `${packageName.trim()}/UPLOAD`;
    const existing = await secretStore.get(ANDROID_SIGNING_KEY_SECRET_TYPE, name);
    if (existing !== undefined) {
      setKeystoreState('present');
      throw new Error('An upload keystore for this app is already in the secret store; not overwriting it.');
    }
    await secretStore.put(ANDROID_SIGNING_KEY_SECRET_TYPE, name, data);
    setKeystoreState('present');
  }

  /** Escrows a user-provided keystore. Returns whether it was stored. */
  async function storeKeystore(data: {
    keystoreBase64: string;
    keystorePassword: string;
    keyAlias: string;
    keyPassword: string;
  }): Promise<boolean> {
    onError(undefined);
    setKeystoreBusy('saving');
    try {
      await escrowKeystore(data);
      return true;
    } catch (error) {
      onError(errorMessage(error, 'Could not store the keystore'));
      return false;
    } finally {
      setKeystoreBusy(undefined);
    }
  }

  /**
   * The first-app path: generate a fresh upload key in the browser (the
   * private key never leaves it except into the secret store) and escrow
   * it under the package, the same custody story as the Apple
   * certificates. Google's Play App Signing re-signs for distribution,
   * so this key only ever signs uploads.
   */
  async function generateKeystore() {
    onError(undefined);
    setKeystoreBusy('generating');
    try {
      await escrowKeystore(await generateAndroidUploadKeystore(packageName.trim()));
    } catch (error) {
      onError(errorMessage(error, 'Could not generate the upload keystore'));
    } finally {
      setKeystoreBusy(undefined);
    }
  }

  // --- Publish --------------------------------------------------------------

  // Same in-action polling as usePublish: the publish button is disabled
  // while running, so one loop owns the whole publish lifecycle.
  async function publish(webhookUrl: string) {
    const token = accessTokenRef.current;
    if (!token) {
      onError('Sign in with Google first.');
      return;
    }
    setState('running');
    setStatus(undefined);
    setPublishError(undefined);
    try {
      const publishId = await startAndroidPublish({
        projectPath: projectPath.trim(),
        packageName: packageName.trim(),
        googleAccessToken: token,
        webhookUrl,
      });
      while (true) {
        await sleep(PUBLISH_POLL_INTERVAL_MS);
        // Backend momentarily unreachable; retry on the next tick.
        const fetched = await fetchPublishStatus(publishId).catch(() => undefined);
        if (!fetched) continue;
        setStatus(fetched);
        if (fetched.state !== 'running') {
          setState(fetched.state);
          if (fetched.error) setPublishError(fetched.error);
          return;
        }
      }
    } catch (error) {
      setPublishError(errorMessage(error, 'Play publish failed'));
      setState('failed');
    }
  }

  const connected =
    isSignedIn &&
    projectPath.trim() !== '' &&
    packageState.status === 'verified' &&
    keystoreState === 'present';

  return {
    // Google session
    isSignedIn,
    signingIn,
    signIn,
    signOut,
    // Project & package
    projectPath,
    setProjectPath,
    detectApp,
    detecting,
    detectionMiss,
    packageName,
    setPackageName,
    packageState,
    verifyPackage,
    // Keystore
    keystoreState,
    keystoreBusy,
    checkKeystore,
    storeKeystore,
    generateKeystore,
    // Publish
    connected,
    state,
    status,
    error: publishError,
    publish,
  };
}
