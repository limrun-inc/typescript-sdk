import { useCallback, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../core/errors';
import {
  loadGoogleIdentityServices,
  PlaystorePublishError,
  publishToPlaystore,
  requestGoogleAccessToken,
  type PlaystorePublishInput,
  type PlaystorePublishResult,
} from './index';

export type UsePlaystorePublishOptions = Partial<
  Pick<PlaystorePublishInput, 'registryApiUrl' | 'token' | 'organizationId'>
> & {
  /** Google OAuth Web application client ID used for sign-in. */
  googleClientId?: string;
};

export type PlaystorePublishStatus = 'idle' | 'signing-in' | 'ready' | 'publishing' | 'published' | 'error';

export type PlaystorePublishRequest = Omit<
  PlaystorePublishInput,
  'registryApiUrl' | 'token' | 'organizationId' | 'accessToken'
>;

export type UsePlaystorePublishResult = {
  status: PlaystorePublishStatus;
  isSignedIn: boolean;
  versionCode?: number;
  error?: string;
  /** Registry error code driving per-cause UX, e.g. versionCodeExists. */
  errorCode?: string;
  /**
   * Warm up the Google sign-in script (e.g. on dialog open) so
   * signInWithGoogle stays synchronous with the click. Resolves true once
   * the script is ready; await it to gate the sign-in button, or ignore
   * the result and rely on the blocked-popup error plus retry.
   */
  preloadGoogle: () => Promise<boolean>;
  signInWithGoogle: () => Promise<boolean>;
  publish: (request: PlaystorePublishRequest) => Promise<PlaystorePublishResult | undefined>;
  /**
   * Clears the outcome state (keeps the Google session). Does not cancel an
   * in-flight sign-in or publish: their completion is ignored status-wise
   * and new calls stay refused until the in-flight one settles.
   */
  reset: () => void;
};

export function usePlaystorePublish({
  registryApiUrl,
  token,
  organizationId,
  googleClientId,
}: UsePlaystorePublishOptions): UsePlaystorePublishResult {
  const [status, setStatus] = useState<PlaystorePublishStatus>('idle');
  // isSignedIn derives from token possession so the two can never diverge,
  // even when a reset() during the popup makes the flow's status stale.
  const [accessToken, setAccessToken] = useState<string | undefined>();
  const [versionCode, setVersionCode] = useState<number | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();
  // The token lives in a ref so publish() right after signInWithGoogle()
  // in one handler sees it before React re-renders.
  const accessTokenRef = useRef<string | undefined>(undefined);
  // reset() bumps the generation so an abandoned in-flight call cannot
  // overwrite the state it settles into.
  const generationRef = useRef(0);
  const busyRef = useRef(false);

  const preloadGoogle = useCallback(
    () =>
      loadGoogleIdentityServices().then(
        () => true,
        () => false,
      ),
    [],
  );

  // Guard failures replace the whole outcome, like the main paths do: a
  // stale errorCode or versionCode must not render beside the new error.
  const failGuard = useCallback((message: string) => {
    setError(message);
    setErrorCode(undefined);
    setVersionCode(undefined);
    setStatus('error');
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (busyRef.current) {
      return false;
    }
    if (!googleClientId) {
      failGuard('Google OAuth client ID is not configured.');
      return false;
    }
    busyRef.current = true;
    const generation = generationRef.current;
    setStatus('signing-in');
    setError(undefined);
    setErrorCode(undefined);
    try {
      const nextToken = await requestGoogleAccessToken({ clientId: googleClientId });
      accessTokenRef.current = nextToken;
      setAccessToken(nextToken);
      if (generation === generationRef.current) {
        setStatus('ready');
      } else {
        // A reset() during the popup ran before the token landed and left
        // idle; upgrade it so status agrees with isSignedIn. Anything but
        // idle belongs to a newer flow and must not be stomped.
        setStatus((current) => (current === 'idle' ? 'ready' : current));
      }
      return true;
    } catch (caught) {
      if (generation === generationRef.current) {
        setError(errorMessage(caught));
        setStatus('error');
      }
      return false;
    } finally {
      busyRef.current = false;
    }
  }, [googleClientId]);

  const publish = useCallback(
    async (request: PlaystorePublishRequest) => {
      if (busyRef.current) {
        return undefined;
      }
      if (!registryApiUrl) {
        failGuard('Registry URL is not configured.');
        return undefined;
      }
      const googleToken = accessTokenRef.current;
      if (!googleToken) {
        failGuard('Sign in with Google before publishing.');
        return undefined;
      }
      busyRef.current = true;
      const generation = generationRef.current;
      setStatus('publishing');
      setError(undefined);
      setErrorCode(undefined);
      // A stale code from an earlier publish must not render as this
      // attempt's success next to an error state.
      setVersionCode(undefined);
      try {
        // Fields picked explicitly: spreading a wider-typed request object
        // could smuggle same-named credential fields or excess properties
        // into the request body.
        const result = await publishToPlaystore({
          registryApiUrl,
          token,
          organizationId,
          accessToken: googleToken,
          packageName: request.packageName,
          assetId: request.assetId,
          assetName: request.assetName,
          track: request.track,
          releaseStatus: request.releaseStatus,
        });
        if (generation === generationRef.current) {
          setVersionCode(result.versionCode);
          setStatus('published');
        }
        return result;
      } catch (caught) {
        if (generation === generationRef.current) {
          setError(errorMessage(caught));
          if (caught instanceof PlaystorePublishError) {
            setErrorCode(caught.code);
          }
          setStatus('error');
        }
        return undefined;
      } finally {
        busyRef.current = false;
      }
    },
    [registryApiUrl, token, organizationId],
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    setVersionCode(undefined);
    setError(undefined);
    setErrorCode(undefined);
    setStatus(accessTokenRef.current ? 'ready' : 'idle');
  }, []);

  // Memoized so the result works as a prop or dependency without
  // re-rendering consumers on unrelated parent renders.
  return useMemo(
    () => ({
      status,
      isSignedIn: accessToken !== undefined,
      versionCode,
      error,
      errorCode,
      preloadGoogle,
      signInWithGoogle,
      publish,
      reset,
    }),
    [status, accessToken, versionCode, error, errorCode, preloadGoogle, signInWithGoogle, publish, reset],
  );
}
