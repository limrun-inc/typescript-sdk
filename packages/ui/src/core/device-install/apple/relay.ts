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

/**
 * A session-authenticated App Store Connect request proxied by the relay.
 * Unlike provisioning requests, payloads pass through as JSON and GET
 * parameters go into an explicit query map because the App Store Connect
 * API uses bracketed JSON:API keys like fields[apiKeys].
 */
export type AppStoreConnectRequest = {
  method?: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  payload?: unknown;
};

type AppleRelayWebSocketMessage<T = unknown> = {
  id: string;
  ok: boolean;
  response?: AppleRelayResponse<T>;
  error?: string;
};

export class AppleRelayWebSocketClient {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      resolve: (response: AppleRelayResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(
    private readonly apiUrl: string,
    private readonly token?: string,
    private readonly organizationId?: string,
  ) {}

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(appleRelayWebSocketURL(this.apiUrl, this.token, this.organizationId));
    this.socket = socket;
    socket.onmessage = (event) => this.handleMessage(event);
    socket.onclose = () => this.rejectPending(new Error('Apple relay WebSocket closed'));
    socket.onerror = () => this.rejectPending(new Error('Apple relay WebSocket failed'));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Apple relay WebSocket connection failed'));
    });
  }

  request<T = unknown>(type: string, payload?: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Apple relay WebSocket is not connected.');
    }
    const id = String(this.nextId++);
    const response = new Promise<AppleRelayResponse<T>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(normalizeAppleProxyResponse<T>(value as AppleRelayResponse<T>)),
        reject,
      });
    });
    socket.send(JSON.stringify({ id, type, ...(payload === undefined ? {} : { payload }) }));
    return response;
  }

  close() {
    this.rejectPending(new Error('Apple relay WebSocket closed'));
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(event: MessageEvent) {
    const message = JSON.parse(String(event.data)) as AppleRelayWebSocketMessage;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (!message.ok) {
      waiter.reject(new Error(message.error || 'Apple relay request failed'));
      return;
    }
    if (!message.response) {
      waiter.reject(new Error('Apple relay response was empty.'));
      return;
    }
    waiter.resolve(message.response);
  }

  private rejectPending(error: Error) {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

export async function openAppleRelayWebSocket(apiUrl: string, token?: string, organizationId?: string) {
  const client = new AppleRelayWebSocketClient(apiUrl, token, organizationId);
  await client.connect();
  return client;
}

export async function proxySrpInit(relay: AppleRelayWebSocketClient, payload: AppleSRPInitRequest) {
  return relay.request<AppleSRPInitResponse>('srpInit', payload);
}

export async function proxySrpComplete(
  relay: AppleRelayWebSocketClient,
  payload: AppleSRPCompleteProof & {
    rememberMe: boolean;
    trustTokens: string[];
  },
) {
  return relay.request('srpComplete', payload);
}

export async function triggerTrustedDeviceTwoFactor(relay: AppleRelayWebSocketClient) {
  return relay.request('triggerTrustedDevice2FA');
}

export async function triggerPhoneTwoFactor(
  relay: AppleRelayWebSocketClient,
  phoneNumberId: number,
  mode = 'sms',
) {
  return relay.request('triggerPhone2FA', { phoneNumberId, mode });
}

export async function proxyTwoFactorCode(relay: AppleRelayWebSocketClient, code: string) {
  return relay.request('submitTrustedDevice2FA', { code });
}

export async function proxyPhoneTwoFactorCode(
  relay: AppleRelayWebSocketClient,
  phoneNumberId: number,
  code: string,
  mode = 'sms',
) {
  return relay.request('submitPhone2FA', { phoneNumberId, mode, code });
}

export async function fetchAppleAccountSession(relay: AppleRelayWebSocketClient) {
  return relay.request('finalize');
}

export async function proxyProvisioningRequest<T = unknown>(
  relay: AppleRelayWebSocketClient,
  request: AppleProvisioningRequest,
) {
  return relay.request<T>('provisioning', request);
}

export async function proxyAppStoreConnectRequest<T = unknown>(
  relay: AppleRelayWebSocketClient,
  request: AppStoreConnectRequest,
) {
  return relay.request<T>('appstoreconnect', request);
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

function appleRelayWebSocketURL(apiUrl: string, token?: string, organizationId?: string) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ios/appstoreconnect/ws`;
  if (token) {
    url.searchParams.set('token', token);
  }
  if (organizationId) {
    url.searchParams.set('organization', organizationId);
  }
  return url.toString();
}
