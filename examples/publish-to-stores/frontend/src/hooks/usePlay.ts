// The Google Play controller, mirroring the iOS split: Connect (Google
// sign-in, package verification against Play, upload keystore in the
// secret store) unlocks Publish (remote signed build + publish, streamed).
// The Google access token lives in memory for the session (~1h) and rides
// each publish request; the Limrun API key never reaches the browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ANDROID_SIGNING_KEY_SECRET_TYPE, type SigningSecretStore } from '@limrun/ui/apple';
import {
  generateAndroidUploadKeystore,
  loadGoogleIdentityServices,
  requestGoogleAccessToken,
} from '@limrun/ui/play-publish';
import { GOOGLE_OAUTH_CLIENT_ID } from '../config';
import { errorMessage } from '../lib/apple';
import { detectAndroidPackage, streamAndroidPublish } from '../lib/backend';
import { probePlayAccess } from '../lib/googlePlay';
import type { PublishLogLine, PublishState } from './usePublish';

const PACKAGE_STORAGE_KEY = 'publish-to-stores.play.packageName';
const PROJECT_STORAGE_KEY = 'publish-to-stores.play.projectPath';

/** How often to re-probe while waiting for the user to create the app. */
const PACKAGE_POLL_INTERVAL_MS = 5000;

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
  // --- Google session ---------------------------------------------------
  // The token is read through a ref so actions right after signIn in the
  // same handler see it before React re-renders (console does the same).
  const accessTokenRef = useRef<string | undefined>(undefined);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // Warm the sign-in script so the consent popup opens synchronously with
  // the click and popup blockers stay quiet.
  useEffect(() => {
    void loadGoogleIdentityServices().catch(() => undefined);
  }, []);

  const signIn = useCallback(async () => {
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
  }, [onError]);

  const signOut = useCallback(() => {
    accessTokenRef.current = undefined;
    setIsSignedIn(false);
    setPackageState({ status: 'unchecked' });
  }, []);

  // --- Project & package detection -----------------------------------------
  const [projectPath, setProjectPathState] = useState(() => localStorage.getItem(PROJECT_STORAGE_KEY) ?? '');
  const [packageName, setPackageNameState] = useState(() => localStorage.getItem(PACKAGE_STORAGE_KEY) ?? '');
  const [packageState, setPackageState] = useState<PackageState>({ status: 'unchecked' });
  const [detecting, setDetecting] = useState(false);
  /** Set when detection ran and found nothing; the user types the package. */
  const [detectionMiss, setDetectionMiss] = useState(false);

  // Probes race: the user can edit the name while one is in flight, and
  // the waiting-state poller can deliver answers out of order. Only the
  // newest probe for the currently entered name may set the state.
  const packageNameRef = useRef(packageName);
  const probeSeq = useRef(0);

  const setPackageName = useCallback((value: string) => {
    packageNameRef.current = value;
    setPackageNameState(value);
    setPackageState({ status: 'unchecked' });
  }, []);

  const setProjectPath = useCallback((value: string) => {
    setProjectPathState(value);
    setDetectionMiss(false);
    // A different path may hold a different app; the verified state must
    // not carry over to whatever the user points at next.
    setPackageState({ status: 'unchecked' });
  }, []);

  const verifyPackage = useCallback(
    async (explicitName?: string) => {
      const token = accessTokenRef.current;
      const trimmed = (explicitName ?? packageName).trim();
      if (!token || !trimmed) return;
      const seq = ++probeSeq.current;
      setPackageState((current) => (current.status === 'waiting' ? current : { status: 'checking' }));
      const probe = await probePlayAccess(token, trimmed);
      if (seq !== probeSeq.current || trimmed !== packageNameRef.current.trim()) return;
      if (probe.result === 'ok') {
        localStorage.setItem(PACKAGE_STORAGE_KEY, trimmed);
        setPackageState({ status: 'verified' });
      } else if (probe.result === 'unauthorized') {
        // The ~1h token expired; the next sign-in click mints a fresh one.
        signOut();
        onError('The Google session expired. Sign in again.');
      } else {
        setPackageState({ status: 'waiting', message: probe.message });
      }
    },
    [onError, packageName, signOut],
  );

  /**
   * The wizard's entry point: inspect the project on the backend host,
   * prefill the detected application ID, and verify it against Play in one
   * go. A detection miss leaves the package field for the user; the
   * backend fills expo.android.package into app.json at publish time.
   */
  const detectApp = useCallback(async () => {
    const trimmedPath = projectPath.trim();
    if (!trimmedPath) return;
    onError(undefined);
    setDetecting(true);
    setDetectionMiss(false);
    try {
      const detected = await detectAndroidPackage(trimmedPath);
      localStorage.setItem(PROJECT_STORAGE_KEY, trimmedPath);
      if (detected) {
        packageNameRef.current = detected;
        setPackageNameState(detected);
        await verifyPackage(detected);
      } else {
        setDetectionMiss(true);
        packageNameRef.current = '';
        setPackageNameState('');
        setPackageState({ status: 'unchecked' });
      }
    } catch (error) {
      onError(errorMessage(error, 'Could not inspect the project'));
    } finally {
      setDetecting(false);
    }
  }, [onError, projectPath, verifyPackage]);

  // While the app is missing on Play Console, keep probing so the
  // moment the user creates the listing in Play Console the wizard moves
  // on by itself.
  useEffect(() => {
    if (packageState.status !== 'waiting') return;
    const timer = setInterval(() => void verifyPackage(), PACKAGE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [packageState.status, verifyPackage]);

  // --- Upload keystore ----------------------------------------------------
  // Four states on purpose: only a definitive 'absent' may render the
  // generate/import forms, because writing over an EXISTING escrowed
  // upload key silently replaces it and breaks every later upload with an
  // upload-key mismatch. 'unknown' means a check is in flight; 'error'
  // means the check failed and the user must retry it.
  const [keystoreState, setKeystoreState] = useState<'unknown' | 'error' | 'absent' | 'present'>('unknown');
  const [keystoreCheckSeq, setKeystoreCheckSeq] = useState(0);
  const recheckKeystore = useCallback(() => setKeystoreCheckSeq((seq) => seq + 1), []);

  useEffect(() => {
    const trimmed = packageName.trim();
    if (!trimmed) {
      setKeystoreState('unknown');
      return;
    }
    let cancelled = false;
    setKeystoreState('unknown');
    void secretStore
      .get(ANDROID_SIGNING_KEY_SECRET_TYPE, `${trimmed}/UPLOAD`)
      .then((secret) => {
        if (!cancelled) setKeystoreState(secret !== undefined ? 'present' : 'absent');
      })
      .catch(() => {
        if (!cancelled) setKeystoreState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [packageName, secretStore, keystoreCheckSeq]);

  /**
   * Escrows an upload keystore under the package. Re-checks the store
   * right before writing, for the imported and the generated key alike:
   * overwriting an existing upload key would break every later upload,
   * so a racing or previously failed check must abort.
   */
  const storeKeystore = useCallback(
    async (data: {
      keystoreBase64: string;
      keystorePassword: string;
      keyAlias: string;
      keyPassword: string;
    }) => {
      const name = `${packageName.trim()}/UPLOAD`;
      const existing = await secretStore.get(ANDROID_SIGNING_KEY_SECRET_TYPE, name);
      if (existing !== undefined) {
        setKeystoreState('present');
        throw new Error(
          'An upload keystore for this app is already in the secret store; not overwriting it.',
        );
      }
      await secretStore.put(ANDROID_SIGNING_KEY_SECRET_TYPE, name, data);
      setKeystoreState('present');
    },
    [packageName, secretStore],
  );

  /**
   * The first-app path: generate a fresh upload key in the browser (the
   * private key never leaves it except into the secret store) and escrow
   * it under the package, the same custody story as the Apple
   * certificates. Google's Play App Signing re-signs for distribution,
   * so this key only ever signs uploads.
   */
  const generateKeystore = useCallback(async () => {
    await storeKeystore(await generateAndroidUploadKeystore(packageName.trim()));
  }, [packageName, storeKeystore]);

  // --- Publish --------------------------------------------------------------
  const [state, setState] = useState<PublishState>('idle');
  const [lines, setLines] = useState<PublishLogLine[]>([]);
  const [exitCode, setExitCode] = useState<number>();

  const publish = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) {
      onError('Sign in with Google first.');
      return;
    }
    setState('running');
    setLines([]);
    setExitCode(undefined);
    try {
      let finalExit: number | undefined;
      await streamAndroidPublish(
        {
          projectPath: projectPath.trim(),
          packageName: packageName.trim(),
          googleAccessToken: token,
        },
        ({ event, data }) => {
          if (event === 'exit') {
            finalExit = Number(data);
            return;
          }
          if (event === 'stdout' || event === 'stderr' || event === 'error') {
            setLines((current) => [...current, { stream: event, text: data }]);
          }
        },
      );
      setExitCode(finalExit);
      setState(finalExit === 0 ? 'succeeded' : 'failed');
    } catch (error) {
      setLines((current) => [
        ...current,
        { stream: 'error', text: errorMessage(error, 'Play publish failed') },
      ]);
      setState('failed');
    }
  }, [onError, packageName, projectPath]);

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
    recheckKeystore,
    storeKeystore,
    generateKeystore,
    // Publish
    connected,
    state,
    lines,
    exitCode,
    publish,
  };
}
