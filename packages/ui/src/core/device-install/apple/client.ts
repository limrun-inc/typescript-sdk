import { AppleGsaSrpClient } from './gsa-srp';
import {
  openAppleRelayWebSocket,
  fetchAppleAccountSession,
  proxyPhoneTwoFactorCode,
  proxySrpComplete,
  proxySrpInit,
  proxyTwoFactorCode,
  triggerPhoneTwoFactor,
  triggerTrustedDeviceTwoFactor,
  type AppleRelayWebSocketClient,
  type AppleRelayResponse,
} from './relay';

export type AppleIDLoginInput = {
  registryApiUrl: string;
  accountName: string;
  password: string;
  token?: string;
  organizationId?: string;
};

export type AppleIDLoginResult = {
  relay: AppleRelayWebSocketClient;
  completeResponse: AppleRelayResponse;
  twoFactorChallengeResponse?: AppleRelayResponse;
  requiresTwoFactor: boolean;
  finishTwoFactor: (code: string) => Promise<AppleRelayResponse>;
  finalize: () => Promise<AppleRelayResponse>;
  close: () => Promise<void>;
};

type TwoFactorMethod = { type: 'trustedDevice' } | { type: 'phone'; phoneNumberId: number; mode: string };

export async function startBrowserOwnedAppleIDLogin({
  registryApiUrl,
  accountName,
  password,
  token,
  organizationId,
}: AppleIDLoginInput): Promise<AppleIDLoginResult> {
  const relay = await openAppleRelayWebSocket(registryApiUrl, token, organizationId);
  try {
    const srp = new AppleGsaSrpClient(accountName);
    const initResponse = await proxySrpInit(relay, await srp.init());
    if (initResponse.status < 200 || initResponse.status >= 300) {
      throw new Error(
        `Apple SRP init failed: HTTP ${initResponse.status} ${initResponse.rawBody ?? ''}`.trim(),
      );
    }
    if (!initResponse.body) {
      throw new Error('Apple SRP init response did not include a body.');
    }
    const proof = await srp.complete(password, initResponse.body);
    const completeResponse = await proxySrpComplete(relay, {
      ...proof,
      rememberMe: false,
      trustTokens: [],
    });
    const requiresTwoFactor = completeResponse.status === 409;
    let twoFactorChallengeResponse: AppleRelayResponse | undefined;
    let twoFactorMethod: TwoFactorMethod = { type: 'trustedDevice' };
    if (requiresTwoFactor) {
      twoFactorChallengeResponse = await triggerTrustedDeviceTwoFactor(relay);
      const phone = trustedPhoneNumberFromChallenge(twoFactorChallengeResponse.body);
      // Route codes through the phone/SMS endpoint only when Apple actually
      // falls back to phone verification: HTTP 412 on the trusted-device
      // trigger, or a 2xx challenge whose body says noTrustedDevices (seen on
      // managed Apple accounts). The trusted-device challenge body frequently
      // includes trusted-phone metadata even for a normal device push;
      // routing those codes to the phone endpoint breaks trusted-device
      // login, while submitting an SMS-fallback code to the trusted-device
      // endpoint returns 201 without completing authentication.
      if (twoFactorChallengeResponse.status === 412 || challengeHasNoTrustedDevices(twoFactorChallengeResponse.body)) {
        if (!phone) {
          throw new Error('Apple requested phone verification but did not include a trusted phone number.');
        }
        twoFactorMethod = {
          type: 'phone',
          phoneNumberId: phone.id,
          mode: phone.pushMode ?? 'sms',
        };
        twoFactorChallengeResponse = await triggerPhoneTwoFactor(relay, phone.id, phone.pushMode ?? 'sms');
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
      relay,
      completeResponse,
      twoFactorChallengeResponse,
      requiresTwoFactor,
      finishTwoFactor: async (code) => {
        const response =
          twoFactorMethod.type === 'phone' ?
            await proxyPhoneTwoFactorCode(relay, twoFactorMethod.phoneNumberId, code, twoFactorMethod.mode)
          : await proxyTwoFactorCode(relay, code);
        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `Apple two-factor code failed: HTTP ${response.status} ${response.rawBody ?? ''}`.trim(),
          );
        }
        return response;
      },
      finalize: async () => fetchAppleAccountSession(relay),
      close: async () => relay.close(),
    };
  } catch (error) {
    relay.close();
    throw error;
  }
}

function challengeHasNoTrustedDevices(body: unknown) {
  return isRecord(body) && body.noTrustedDevices === true;
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
