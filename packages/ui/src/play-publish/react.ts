import { useCallback, useRef, useState } from 'react';
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
  /** Warm up the Google sign-in script (e.g. on dialog open) so signInWithGoogle stays synchronous with the click. */
  preloadGoogle: () => void;
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
  const [isSignedIn, setIsSignedIn] = useState(false);
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

  const preloadGoogle = useCallback(() => {
    void loadGoogleIdentityServices().catch(() => undefined);
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (busyRef.current) {
      return false;
    }
    if (!googleClientId) {
      setError('Google OAuth client ID is not configured.');
      setStatus('error');
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
      // isSignedIn mirrors token possession, so it is set even when a
      // reset() during the popup made the flow's status stale.
      setIsSignedIn(true);
      if (generation === generationRef.current) {
        setStatus('ready');
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
        setError('Registry URL is not configured.');
        setStatus('error');
        return undefined;
      }
      const accessToken = accessTokenRef.current;
      if (!accessToken) {
        setError('Sign in with Google before publishing.');
        setStatus('error');
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
        // Hook-owned fields spread last: excess-property checking does not
        // protect wider-typed request objects from smuggling in same-named
        // credential fields.
        const result = await publishToPlaystore({
          ...request,
          registryApiUrl,
          token,
          organizationId,
          accessToken,
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

  return {
    status,
    isSignedIn,
    versionCode,
    error,
    errorCode,
    preloadGoogle,
    signInWithGoogle,
    publish,
    reset,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
