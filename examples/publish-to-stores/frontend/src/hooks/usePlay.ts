// The Google Play controller, mirroring the iOS split: Connect (Google
// sign-in, package verification against Play, upload keystore in the
// secret store) unlocks Publish (remote signed build + publish, streamed).
// The Google access token lives in memory for the session (~1h) and rides
// each publish request; the Limrun API key never reaches the browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ANDROID_SIGNING_KEY_SECRET_TYPE, type SigningSecretStore } from '@limrun/ui/apple';
import { loadGoogleIdentityServices, requestGoogleAccessToken } from '@limrun/ui/play-publish';
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

  const setPackageName = useCallback((value: string) => {
    setPackageNameState(value);
    setPackageState({ status: 'unchecked' });
  }, []);

  const setProjectPath = useCallback((value: string) => {
    setProjectPathState(value);
    setDetectionMiss(false);
  }, []);

  const verifyPackage = useCallback(
    async (explicitName?: string) => {
      const token = accessTokenRef.current;
      const trimmed = (explicitName ?? packageName).trim();
      if (!token || !trimmed) return;
      setPackageState((current) => (current.status === 'waiting' ? current : { status: 'checking' }));
      const probe = await probePlayAccess(token, trimmed);
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
  const [keystoreStored, setKeystoreStored] = useState(false);

  useEffect(() => {
    const trimmed = packageName.trim();
    if (!trimmed) {
      setKeystoreStored(false);
      return;
    }
    let cancelled = false;
    void secretStore
      .get(ANDROID_SIGNING_KEY_SECRET_TYPE, `${trimmed}/UPLOAD`)
      .then((secret) => {
        if (!cancelled) setKeystoreStored(secret !== undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [packageName, secretStore]);

  const storeKeystore = useCallback(
    async (data: {
      keystoreBase64: string;
      keystorePassword: string;
      keyAlias: string;
      keyPassword: string;
    }) => {
      await secretStore.put(ANDROID_SIGNING_KEY_SECRET_TYPE, `${packageName.trim()}/UPLOAD`, data);
      setKeystoreStored(true);
    },
    [packageName, secretStore],
  );

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
    isSignedIn && projectPath.trim() !== '' && packageState.status === 'verified' && keystoreStored;

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
    keystoreStored,
    storeKeystore,
    // Publish
    connected,
    state,
    lines,
    exitCode,
    publish,
  };
}
