import { AppleGsaSrpClient, type AppleSRPInitResponse } from './gsa-srp';
import {
  fetchAppleAccountSession,
  openAppleRelayWebSocket,
  type AppleRelayResponse,
  type AppleRelayWebSocketClient,
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

/**
 * Signs into an Apple ID through the relay using SRP, so the password never
 * leaves the browser in a recoverable form. Returns the connected relay plus
 * a two-factor continuation when Apple requires one.
 */
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
    const initResponse = await relay.request<AppleSRPInitResponse>('srpInit', await srp.init());
    if (initResponse.status < 200 || initResponse.status >= 300) {
      throw new Error(
        `Apple SRP init failed: HTTP ${initResponse.status} ${initResponse.rawBody ?? ''}`.trim(),
      );
    }
    if (!initResponse.body) {
      throw new Error('Apple SRP init response did not include a body.');
    }
    const proof = await srp.complete(password, initResponse.body);
    const completeResponse = await relay.request('srpComplete', {
      ...proof,
      rememberMe: false,
      trustTokens: [],
    });
    const requiresTwoFactor = completeResponse.status === 409;
    let twoFactorChallengeResponse: AppleRelayResponse | undefined;
    let twoFactorMethod: TwoFactorMethod = { type: 'trustedDevice' };
    if (requiresTwoFactor) {
      twoFactorChallengeResponse = await relay.request('triggerTrustedDevice2FA');
      const phone = trustedPhoneNumberFromChallenge(twoFactorChallengeResponse.body);
      // Route codes through the phone/SMS endpoint only when Apple actually
      // falls back to phone verification: HTTP 412 on the trusted-device
      // trigger, or a 2xx challenge whose body says noTrustedDevices (seen on
      // managed Apple accounts). The trusted-device challenge body frequently
      // includes trusted-phone metadata even for a normal device push;
      // routing those codes to the phone endpoint breaks trusted-device
      // login, while submitting an SMS-fallback code to the trusted-device
      // endpoint returns 201 without completing authentication.
      if (
        twoFactorChallengeResponse.status === 412 ||
        challengeHasNoTrustedDevices(twoFactorChallengeResponse.body)
      ) {
        if (!phone) {
          throw new Error('Apple requested phone verification but did not include a trusted phone number.');
        }
        const mode = phone.pushMode ?? 'sms';
        twoFactorMethod = { type: 'phone', phoneNumberId: phone.id, mode };
        twoFactorChallengeResponse = await relay.request('triggerPhone2FA', {
          phoneNumberId: phone.id,
          mode,
        });
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
            await relay.request('submitPhone2FA', {
              phoneNumberId: twoFactorMethod.phoneNumberId,
              mode: twoFactorMethod.mode,
              code,
            })
          : await relay.request('submitTrustedDevice2FA', { code });
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
