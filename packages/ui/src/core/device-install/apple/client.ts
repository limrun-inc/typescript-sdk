import { AppleGsaSrpClient } from './gsa-srp';
import {
  createAppleRelaySession,
  deleteAppleRelaySession,
  finalizeAppleRelaySession,
  proxySrpComplete,
  proxySrpInit,
  proxyTwoFactorCode,
  type AppleRelayResponse,
} from './relay';

export type AppleIDLoginInput = {
  limbuildApiUrl: string;
  accountName: string;
  password: string;
  token?: string;
};

export type AppleIDLoginResult = {
  appleSessionId: string;
  completeResponse: AppleRelayResponse;
  requiresTwoFactor: boolean;
  finishTwoFactor: (code: string) => Promise<AppleRelayResponse>;
  finalize: () => Promise<AppleRelayResponse>;
  close: () => Promise<void>;
};

export async function startBrowserOwnedAppleIDLogin({
  limbuildApiUrl,
  accountName,
  password,
  token,
}: AppleIDLoginInput): Promise<AppleIDLoginResult> {
  const { appleSessionId } = await createAppleRelaySession(limbuildApiUrl, token);
  try {
    const srp = new AppleGsaSrpClient(accountName);
    const initResponse = await proxySrpInit(limbuildApiUrl, appleSessionId, await srp.init(), token);
    if (!initResponse.body) {
      throw new Error('Apple SRP init response did not include a body.');
    }
    const proof = await srp.complete(password, initResponse.body);
    const completeResponse = await proxySrpComplete(
      limbuildApiUrl,
      appleSessionId,
      {
        ...proof,
        rememberMe: false,
        trustTokens: [],
      },
      token,
    );
    return {
      appleSessionId,
      completeResponse,
      requiresTwoFactor: completeResponse.status === 409,
      finishTwoFactor: (code) => proxyTwoFactorCode(limbuildApiUrl, appleSessionId, code, token),
      finalize: () => finalizeAppleRelaySession(limbuildApiUrl, appleSessionId, token),
      close: () => deleteAppleRelaySession(limbuildApiUrl, appleSessionId, token),
    };
  } catch (error) {
    await deleteAppleRelaySession(limbuildApiUrl, appleSessionId, token).catch(() => undefined);
    throw error;
  }
}
