import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppleRelayError,
  startBrowserOwnedAppleIDLogin,
  type AppleIDLoginInput,
  type AppleIDLoginResult,
  type AppleRelayResponse,
} from './index';
import { errorMessage } from './internal/errors';

export type UseAppleIDLoginOptions = Pick<AppleIDLoginInput, 'registryApiUrl' | 'token' | 'organizationId'>;

export type AppleIDLoginStatus =
  | 'idle'
  | 'authenticating'
  | 'two-factor-required'
  | 'authenticated'
  | 'error';

export type UseAppleIDLoginResult = {
  status: AppleIDLoginStatus;
  session?: AppleIDLoginResult;
  completeResponse?: AppleRelayResponse;
  twoFactorChallengeResponse?: AppleRelayResponse;
  error?: string;
  relaySessionId?: string;
  startLogin: (
    input: Pick<AppleIDLoginInput, 'accountName' | 'password'>,
  ) => Promise<AppleIDLoginResult | undefined>;
  submitTwoFactorCode: (code: string) => Promise<AppleRelayResponse | undefined>;
  finalize: () => Promise<AppleRelayResponse | undefined>;
  close: () => Promise<void>;
};

export function useAppleIDLogin({
  registryApiUrl,
  token,
  organizationId,
}: UseAppleIDLoginOptions): UseAppleIDLoginResult {
  const [status, setStatus] = useState<AppleIDLoginStatus>('idle');
  const [session, setSession] = useState<AppleIDLoginResult | undefined>();
  const [completeResponse, setCompleteResponse] = useState<AppleRelayResponse | undefined>();
  const [twoFactorChallengeResponse, setTwoFactorChallengeResponse] = useState<
    AppleRelayResponse | undefined
  >();
  const [relaySessionId, setRelaySessionId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const sessionRef = useRef<AppleIDLoginResult | undefined>(undefined);

  const close = useCallback(async () => {
    await sessionRef.current?.close().catch(() => undefined);
    sessionRef.current = undefined;
    setSession(undefined);
    setCompleteResponse(undefined);
    setTwoFactorChallengeResponse(undefined);
    setError(undefined);
    setRelaySessionId(undefined);
    setStatus('idle');
  }, []);

  useEffect(() => {
    return () => {
      void sessionRef.current?.close();
      sessionRef.current = undefined;
    };
  }, []);

  const startLogin = useCallback(
    async ({ accountName, password }: Pick<AppleIDLoginInput, 'accountName' | 'password'>) => {
      setRelaySessionId(undefined);
      setStatus('authenticating');
      setError(undefined);
      await sessionRef.current?.close().catch(() => undefined);
      try {
        const next = await startBrowserOwnedAppleIDLogin({
          registryApiUrl,
          token,
          organizationId,
          accountName,
          password,
        });
        sessionRef.current = next;
        setSession(next);
        setRelaySessionId(next.relay.relaySessionId);
        setCompleteResponse(next.completeResponse);
        setTwoFactorChallengeResponse(next.twoFactorChallengeResponse);
        setStatus(next.requiresTwoFactor ? 'two-factor-required' : 'authenticated');
        return next;
      } catch (caught) {
        setSession(undefined);
        sessionRef.current = undefined;
        setRelaySessionId(caught instanceof AppleRelayError ? caught.relaySessionId : undefined);
        setError(errorMessage(caught));
        setStatus('error');
        return undefined;
      }
    },
    [registryApiUrl, organizationId, token],
  );

  const submitTwoFactorCode = useCallback(async (code: string) => {
    const current = sessionRef.current;
    if (!current) {
      throw new Error('Start Apple ID login before submitting a two-factor code.');
    }
    setStatus('authenticating');
    setError(undefined);
    try {
      const response = await current.finishTwoFactor(code);
      setStatus('authenticated');
      return response;
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus('error');
      return undefined;
    }
  }, []);

  const finalize = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) {
      throw new Error('Start Apple ID login before finalizing the Apple session.');
    }
    return current.finalize();
  }, []);

  return {
    status,
    session,
    completeResponse,
    twoFactorChallengeResponse,
    error,
    relaySessionId,
    startLogin,
    submitTwoFactorCode,
    finalize,
    close,
  };
}
