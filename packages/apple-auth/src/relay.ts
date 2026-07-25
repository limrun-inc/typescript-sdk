export type AppleRelayResponse<T = unknown> = {
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: T;
  rawBody?: string;
  rawBodyBase64?: string;
};

type AppleRelayWebSocketMessage<T = unknown> = {
  id: string;
  ok: boolean;
  response?: AppleRelayResponse<T>;
  error?: string;
};

/**
 * The browser side of Limrun's Apple relay: a WebSocket that proxies
 * requests to Apple's login, Developer Portal and App Store Connect
 * endpoints while the session cookies stay on the relay. Response bytes
 * always come back to the browser; the relay stores nothing.
 */
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

/** Fetches the Apple account session, which primes the relay's portal cookies. */
export async function fetchAppleAccountSession(relay: AppleRelayWebSocketClient) {
  return relay.request('finalize');
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
