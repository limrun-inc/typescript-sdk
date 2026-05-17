import type { AppleSRPCompleteProof, AppleSRPInitRequest, AppleSRPInitResponse } from './gsa-srp';

export type AppleRelayResponse<T = unknown> = {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: T;
  rawBody?: string;
  bodyBase64?: string;
};

export type AppleRelayRequest = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: BodyInit;
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

export async function deleteAppleRelaySession(
  limbuildApiUrl: string,
  appleSessionId: string,
  token?: string,
) {
  const response = await fetch(limbuildURL(limbuildApiUrl, '/apple/auth/session/delete', token), {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ appleSessionId }),
  });
  if (!response.ok) {
    throw new Error(`Apple relay session delete failed: HTTP ${response.status} ${await response.text()}`);
  }
}

export async function relayAppleRequest<T = unknown>(
  limbuildApiUrl: string,
  appleSessionId: string,
  request: AppleRelayRequest,
  token?: string,
) {
  const response = await fetch(appleRelayURL(limbuildApiUrl, appleSessionId, request.url, token), {
    method: request.method ?? 'GET',
    headers: {
      ...(request.headers ?? {}),
      ...authHeaders(token),
    },
    body: request.body,
  });
  return responseToAppleRelayResponse<T>(response);
}

export async function proxySrpInit(
  limbuildApiUrl: string,
  appleSessionId: string,
  payload: AppleSRPInitRequest,
  token?: string,
) {
  return relayAppleRequest<AppleSRPInitResponse>(
    limbuildApiUrl,
    appleSessionId,
    {
      method: 'POST',
      url: 'https://idmsa.apple.com/appleauth/auth/signin/init',
      headers: jsonContentHeaders(),
      body: JSON.stringify(payload),
    },
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
  const hashcash = await fetchAppleHashcash(limbuildApiUrl, appleSessionId, token);
  return relayAppleRequest(
    limbuildApiUrl,
    appleSessionId,
    {
      method: 'POST',
      url: 'https://idmsa.apple.com/appleauth/auth/signin/complete?isRememberMeEnabled=false',
      headers: {
        ...jsonContentHeaders(),
        ...(hashcash ? { 'X-Apple-HC': hashcash } : {}),
      },
      body: JSON.stringify(payload),
    },
    token,
  );
}

export async function proxyTwoFactorCode(
  limbuildApiUrl: string,
  appleSessionId: string,
  code: string,
  token?: string,
) {
  return relayAppleRequest(
    limbuildApiUrl,
    appleSessionId,
    {
      method: 'POST',
      url: 'https://idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode',
      headers: jsonContentHeaders(),
      body: JSON.stringify({ securityCode: { code } }),
    },
    token,
  );
}

export async function finalizeAppleRelaySession(
  limbuildApiUrl: string,
  appleSessionId: string,
  token?: string,
) {
  return relayAppleRequest(
    limbuildApiUrl,
    appleSessionId,
    {
      method: 'GET',
      url: 'https://appstoreconnect.apple.com/olympus/v1/session',
      headers: { Accept: 'application/json' },
    },
    token,
  );
}

export async function proxyProvisioningRequest<T = unknown>(
  limbuildApiUrl: string,
  appleSessionId: string,
  request: AppleProvisioningRequest,
  token?: string,
) {
  return relayAppleRequest<T>(
    limbuildApiUrl,
    appleSessionId,
    {
      method: request.method ?? 'GET',
      url: `https://developer.apple.com/services-account/QH65B2${request.path}`,
      headers: {
        Accept: 'application/json',
        ...(request.payload ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: request.payload ? formEncode(request.payload) : undefined,
    },
    token,
  );
}

function limbuildURL(limbuildApiUrl: string, path: string, token?: string) {
  const url = new URL(path, limbuildApiUrl);
  if (token) {
    url.searchParams.set('token', token);
  }
  return url;
}

function appleRelayURL(limbuildApiUrl: string, appleSessionId: string, appleURL: string, token?: string) {
  const url = limbuildURL(limbuildApiUrl, '/apple/relay', token);
  url.searchParams.set('appleSessionId', appleSessionId);
  url.searchParams.set('url', appleURL);
  return url;
}

function jsonHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function jsonContentHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

async function responseToAppleRelayResponse<T>(response: Response): Promise<AppleRelayResponse<T>> {
  const rawBody = await response.text();
  let body: T | undefined;
  try {
    body = rawBody ? (JSON.parse(rawBody) as T) : undefined;
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    statusText: `${response.status} ${response.statusText}`.trim(),
    headers: Object.fromEntries(response.headers.entries()),
    body,
    rawBody,
    bodyBase64: bytesToBase64(new TextEncoder().encode(rawBody)),
  };
}

async function fetchAppleHashcash(limbuildApiUrl: string, appleSessionId: string, token?: string) {
  const config = await relayAppleRequest<{ authServiceKey?: string }>(
    limbuildApiUrl,
    appleSessionId,
    {
      method: 'GET',
      url: 'https://appstoreconnect.apple.com/olympus/v1/app/config?hostname=itunesconnect.apple.com',
      headers: { Accept: 'application/json' },
    },
    token,
  );
  const widgetKey = config.body?.authServiceKey;
  const response = await relayAppleRequest(
    limbuildApiUrl,
    appleSessionId,
    {
      method: 'GET',
      url: `https://idmsa.apple.com/appleauth/auth/signin${widgetKey ? `?widgetKey=${encodeURIComponent(widgetKey)}` : ''}`,
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    },
    token,
  );
  const bits = response.headers?.['x-apple-hc-bits'];
  const challenge = response.headers?.['x-apple-hc-challenge'];
  if (!bits || !challenge) {
    return undefined;
  }
  return makeAppleHashcash(parseInt(bits, 10), challenge);
}

async function makeAppleHashcash(bits: number, challenge: string) {
  if (!Number.isFinite(bits) || bits <= 0) {
    return undefined;
  }
  const date = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  for (let counter = 0; ; counter += 1) {
    const value = `1:${bits}:${date}:${challenge}::${counter}`;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value)));
    if (hasLeadingZeroBits(digest, bits)) {
      return value;
    }
  }
}

function hasLeadingZeroBits(bytes: Uint8Array, bits: number) {
  for (const byte of bytes) {
    if (bits <= 0) return true;
    if (bits >= 8) {
      if (byte !== 0) return false;
      bits -= 8;
      continue;
    }
    return byte >> (8 - bits) === 0;
  }
  return bits <= 0;
}

function formEncode(payload: unknown) {
  const params = new URLSearchParams();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return params;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.set(key, String(value));
    } else {
      params.set(key, JSON.stringify(value));
    }
  }
  return params;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
