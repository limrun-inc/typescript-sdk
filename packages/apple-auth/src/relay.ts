export type AppleRelayResponse<T = unknown> = {
  relaySessionId?: string;
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  body?: T;
  rawBody?: string;
  rawBodyBase64?: string;
};

type AppleRelayWebSocketMessage<T = unknown> = {
  id: string;
  type?: 'session';
  relaySessionId?: string;
  ok: boolean;
  response?: AppleRelayResponse<T>;
  error?: string;
};

/** Carries a support reference without using Apple's authentication session identifiers. */
export class AppleRelayError extends Error {
  constructor(
    message: string,
    readonly relaySessionId?: string,
  ) {
    super(message);
    this.name = 'AppleRelayError';
  }
}

/**
 * The browser side of Limrun's Apple relay: a WebSocket that proxies
 * requests to Apple's login, Developer Portal and App Store Connect
 * endpoints while the session cookies stay on the relay. Response bytes
 * always come back to the browser; the relay stores nothing.
 */
export class AppleRelayWebSocketClient {
  private socket?: WebSocket;
  private nextId = 1;
  private sessionId?: string;

  /** Available after the server announces the connection or sends its first response. */
  get relaySessionId(): string | undefined {
    return this.sessionId;
  }
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
    this.close();
    this.sessionId = undefined;
    const socket = new WebSocket(appleRelayWebSocketURL(this.apiUrl, this.token, this.organizationId));
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handleMessage(event);
    };
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => {
        if (this.socket !== socket) return;
        const error = new AppleRelayError('Apple relay WebSocket failed', this.sessionId);
        reject(error);
        this.rejectPending(error);
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        const error = new AppleRelayError('Apple relay WebSocket closed', this.sessionId);
        reject(error);
        this.rejectPending(error);
      };
    });
  }

  request<T = unknown>(type: string, payload?: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new AppleRelayError('Apple relay WebSocket is not connected.', this.sessionId);
    }
    const id = String(this.nextId++);
    const response = new Promise<AppleRelayResponse<T>>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(normalizeAppleProxyResponse<T>(value as AppleRelayResponse<T>)),
        reject,
      });
    });
    try {
      socket.send(JSON.stringify({ id, type, ...(payload === undefined ? {} : { payload }) }));
    } catch (error) {
      this.pending
        .get(id)
        ?.reject(new AppleRelayError(error instanceof Error ? error.message : String(error), this.sessionId));
      this.pending.delete(id);
    }
    return response;
  }

  close() {
    this.rejectPending(new AppleRelayError('Apple relay WebSocket closed', this.sessionId));
    this.socket?.close();
    this.socket = undefined;
  }

  private handleMessage(event: MessageEvent) {
    const message = JSON.parse(String(event.data)) as AppleRelayWebSocketMessage;
    if (message.relaySessionId) this.sessionId = message.relaySessionId;
    if (message.type === 'session') return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (!message.ok) {
      waiter.reject(new AppleRelayError(message.error || 'Apple relay request failed', this.sessionId));
      return;
    }
    if (!message.response) {
      waiter.reject(new AppleRelayError('Apple relay response was empty.', this.sessionId));
      return;
    }
    waiter.resolve({ ...message.response, relaySessionId: this.sessionId });
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
