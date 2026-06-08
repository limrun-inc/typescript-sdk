import { AppleGsaSrpClient } from './gsa-srp';
import {
  createAppleRelaySession,
  deleteAppleRelaySession,
  fetchAppleAccountSession,
  proxyPhoneTwoFactorCode,
  proxySrpComplete,
  proxySrpInit,
  proxyTwoFactorCode,
  triggerPhoneTwoFactor,
  triggerTrustedDeviceTwoFactor,
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
  twoFactorChallengeResponse?: AppleRelayResponse;
  requiresTwoFactor: boolean;
  finishTwoFactor: (code: string) => Promise<AppleRelayResponse>;
  finalize: () => Promise<AppleRelayResponse>;
  close: () => Promise<void>;
};

type TwoFactorMethod = { type: 'trustedDevice' } | { type: 'phone'; phoneNumberId: number; mode: string };

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
    if (initResponse.status < 200 || initResponse.status >= 300) {
      throw new Error(
        `Apple SRP init failed: HTTP ${initResponse.status} ${initResponse.rawBody ?? ''}`.trim(),
      );
    }
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
    const requiresTwoFactor = completeResponse.status === 409;
    let twoFactorChallengeResponse: AppleRelayResponse | undefined;
    let twoFactorMethod: TwoFactorMethod = { type: 'trustedDevice' };
    if (requiresTwoFactor) {
      twoFactorChallengeResponse = await triggerTrustedDeviceTwoFactor(limbuildApiUrl, appleSessionId, token);
      const phone = trustedPhoneNumberFromChallenge(twoFactorChallengeResponse.body);
      // Only route codes through the phone/SMS endpoint when Apple actually
      // falls back to phone verification (HTTP 412). The trusted-device
      // challenge body frequently includes trusted-phone metadata even for a
      // normal device push; routing those codes to the phone endpoint breaks
      // trusted-device login.
      if (twoFactorChallengeResponse.status === 412) {
        if (!phone) {
          throw new Error('Apple requested phone verification but did not include a trusted phone number.');
        }
        twoFactorMethod = {
          type: 'phone',
          phoneNumberId: phone.id,
          mode: phone.pushMode ?? 'sms',
        };
        twoFactorChallengeResponse = await triggerPhoneTwoFactor(
          limbuildApiUrl,
          appleSessionId,
          phone.id,
          phone.pushMode ?? 'sms',
          token,
        );
      }
      if (twoFactorChallengeResponse.status < 200 || twoFactorChallengeResponse.status >= 300) {
        throw new Error(
          `Apple two-factor challenge failed: HTTP ${twoFactorChallengeResponse.status} ${
            twoFactorChallengeResponse.rawBody ?? ''
          }`.trim(),
        );
      }
    } else if (completeResponse.status < 200 || completeResponse.status >= 300) {
      throw new Error(
        `Apple SRP complete failed: HTTP ${completeResponse.status} ${completeResponse.rawBody ?? ''}`.trim(),
      );
    }
    return {
      appleSessionId,
      completeResponse,
      twoFactorChallengeResponse,
      requiresTwoFactor,
      finishTwoFactor: async (code) => {
        const response =
          twoFactorMethod.type === 'phone' ?
            await proxyPhoneTwoFactorCode(
              limbuildApiUrl,
              appleSessionId,
              twoFactorMethod.phoneNumberId,
              code,
              twoFactorMethod.mode,
              token,
            )
          : await proxyTwoFactorCode(limbuildApiUrl, appleSessionId, code, token);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `Apple two-factor code failed: HTTP ${response.status} ${response.rawBody ?? ''}`.trim(),
          );
        }
        return response;
      },
      finalize: async () => fetchAppleAccountSession(limbuildApiUrl, appleSessionId, token),
      close: () => deleteAppleRelaySession(limbuildApiUrl, appleSessionId, token),
    };
  } catch (error) {
    await deleteAppleRelaySession(limbuildApiUrl, appleSessionId, token).catch(() => undefined);
    throw error;
  }
}

function trustedPhoneNumberFromChallenge(body: unknown) {
  if (!isRecord(body)) return undefined;
  const verification = isRecord(body.phoneNumberVerification) ? body.phoneNumberVerification : undefined;
  const trustedPhoneNumber =
    recordValue(verification?.trustedPhoneNumber) ??
    recordValue(body.trustedPhoneNumber) ??
    recordValue(body.phoneNumber);
  if (!trustedPhoneNumber) return undefined;
  const id = trustedPhoneNumber.id;
  if (typeof id !== 'number') return undefined;
  const pushMode =
    typeof trustedPhoneNumber.pushMode === 'string' ? trustedPhoneNumber.pushMode
    : typeof body.mode === 'string' ? body.mode
    : undefined;
  return { id, pushMode };
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
