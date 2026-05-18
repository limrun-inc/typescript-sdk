import type { AppleSRPCompleteProof, AppleSRPInitRequest, AppleSRPInitResponse } from './gsa-srp';

export type AppleRelayResponse<T = unknown> = {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: T;
  rawBody?: string;
  rawBodyBase64?: string;
};

export type AppleProvisioningRequest = {
  method?: 'GET' | 'POST';
  path: string;
  payload?: unknown;
};

export async function createAppleRelaySession(limbuildApiUrl: string, token?: string) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/session', token), {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`Apple relay session failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { appleSessionId: string };
}

export async function deleteAppleRelaySession(limbuildApiUrl: string, appleSessionId: string, token?: string) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/session/delete', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId }),
  });
  if (!response.ok) {
    throw new Error(`Apple relay session delete failed: HTTP ${response.status} ${await response.text()}`);
  }
}

export async function proxySrpInit(
  limbuildApiUrl: string,
  appleSessionId: string,
  payload: AppleSRPInitRequest,
  token?: string,
) {
  return postAppleProxy<AppleSRPInitResponse>(
    limbuildApiUrl,
    '/apple/auth/srp/init',
    appleSessionId,
    payload,
    token,
  );
}

export async function proxySrpComplete(
  limbuildApiUrl: string,
  appleSessionId: string,
  payload: AppleSRPCompleteProof & {
    rememberMe: boolean;
    trustTokens: string[];
  },
  token?: string,
) {
  return postAppleProxy(limbuildApiUrl, '/apple/auth/srp/complete', appleSessionId, payload, token);
}

export async function triggerTrustedDeviceTwoFactor(
  limbuildApiUrl: string,
  appleSessionId: string,
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/2fa/trigger', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId }),
  });
  if (!response.ok) {
    throw new Error(`Apple 2FA trigger failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as AppleRelayResponse;
}

export async function triggerPhoneTwoFactor(
  limbuildApiUrl: string,
  appleSessionId: string,
  phoneNumberId: number,
  mode = 'sms',
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/2fa/phone/trigger', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId, phoneNumberId, mode }),
  });
  if (!response.ok) {
    throw new Error(`Apple phone 2FA trigger failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as AppleRelayResponse;
}

export async function proxyTwoFactorCode(
  limbuildApiUrl: string,
  appleSessionId: string,
  code: string,
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/2fa', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId, code }),
  });
  if (!response.ok) {
    throw new Error(`Apple 2FA proxy failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as AppleRelayResponse;
}

export async function proxyPhoneTwoFactorCode(
  limbuildApiUrl: string,
  appleSessionId: string,
  phoneNumberId: number,
  code: string,
  mode = 'sms',
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/2fa/phone', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId, phoneNumberId, mode, code }),
  });
  if (!response.ok) {
    throw new Error(`Apple phone 2FA proxy failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as AppleRelayResponse;
}

export async function fetchAppleAccountSession(
  limbuildApiUrl: string,
  appleSessionId: string,
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/finalize', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId }),
  });
  if (!response.ok) {
    throw new Error(`Apple session finalization failed: HTTP ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as AppleRelayResponse;
}

export async function proxyProvisioningRequest<T = unknown>(
  limbuildApiUrl: string,
  appleSessionId: string,
  request: AppleProvisioningRequest,
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/provisioning', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId, ...request }),
  });
  if (!response.ok) {
    throw new Error(`Apple provisioning proxy failed: HTTP ${response.status} ${await response.text()}`);
  }
  return normalizeAppleProxyResponse<T>((await response.json()) as AppleRelayResponse<T>);
}

async function postAppleProxy<T>(
  limbuildApiUrl: string,
  path: string,
  appleSessionId: string,
  payload: unknown,
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, path, token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId, payload }),
  });
  if (!response.ok) {
    throw new Error(`Apple proxy ${path} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return normalizeAppleProxyResponse<T>((await response.json()) as AppleRelayResponse<T>);
}

function normalizeAppleProxyResponse<T>(response: AppleRelayResponse<T>) {
  if (response.body !== undefined || !response.rawBody) {
    return response;
  }
  try {
    return {
      ...response,
      body: JSON.parse(response.rawBody) as T,
    };
  } catch {
    return response;
  }
}

function limbuildURL(limbuildApiUrl: string, path: string, token?: string) {
  const base = limbuildApiUrl.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  if (token) {
    url.searchParams.set('token', token);
  }
  return url;
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...authHeaders(token),
  };
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
