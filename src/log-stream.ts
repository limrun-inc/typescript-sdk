import { EventEmitter } from 'events';
import { WebSocket, Data } from 'ws';
import { nodeProxyTransport } from './internal/proxy-transport';
import { followAppLogEvents, type AppLogEventsSource } from './internal/app-log-events';

/**
 * Handle for a running log stream subscription (app logs, syslog, or logcat).
 *
 * Uses a dedicated WebSocket connection separate from the main signaling connection.
 * Emits batched log lines every ~500ms when new lines arrive.
 */
export interface LogStreamEvents {
  lines: (lines: string[]) => void;
  line: (line: string) => void;
  error: (error: Error) => void;
  close: () => void;
}

/** @internal - Message from log stream WebSocket */
type LogStreamMessage = {
  type: string;
  id: string;
  lines?: string[];
  error?: string;
};

/**
 * Log stream with a connection of its own, separate from signaling: a WebSocket for syslog and
 * logcat, and server-sent events for app logs.
 */
export class LogStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptionId: string;
  private stopped = false;
  private terminateMessageType: string;
  private sse: AbortController | null = null;

  /**
   * @internal - Either a signaling WebSocket subscription, or the instance's app log
   * server-sent events (`GET /app-logs/stream`), which emit one line per event.
   */
  constructor(
    private wsUrl: string | AppLogEventsSource,
    private subscribeMessage: object = {},
    terminateMessageType: string = '',
    subscriptionId: string = '',
  ) {
    super();
    this.terminateMessageType = terminateMessageType;
    this.subscriptionId = subscriptionId;
    if (typeof wsUrl === 'string') {
      this._connect(wsUrl);
    } else {
      this._follow(wsUrl);
    }
  }

  override on<E extends keyof LogStreamEvents>(event: E, listener: LogStreamEvents[E]): this {
    return super.on(event, listener as any);
  }

  override once<E extends keyof LogStreamEvents>(event: E, listener: LogStreamEvents[E]): this {
    return super.once(event, listener as any);
  }

  override off<E extends keyof LogStreamEvents>(event: E, listener: LogStreamEvents[E]): this {
    return super.off(event, listener as any);
  }

  /** Stop the log stream and close the dedicated WebSocket connection */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sse?.abort();
    this.sse = null;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Send terminate message before closing
      const terminateMsg = { type: this.terminateMessageType, id: this.subscriptionId };
      try {
        this.ws.send(JSON.stringify(terminateMsg));
      } catch {
        // Ignore send errors during shutdown
      }
      this.ws.close();
    }
    this.ws = null;
    this.emit('close');
  }

  /** @internal - Follow the app log's server-sent events */
  private _follow(source: AppLogEventsSource): void {
    const controller = new AbortController();
    this.sse = controller;
    // Emit after the caller attached its listeners, as the WebSocket stream does.
    void Promise.resolve()
      .then(() =>
        followAppLogEvents(
          source,
          (line) => {
            if (this.stopped) return;
            this.emit('lines', [line]);
            this.emit('line', line);
          },
          controller.signal,
        ),
      )
      .then(
        () => {
          if (this.stopped) return;
          this.stopped = true;
          this.sse = null;
          this.emit('close');
        },
        (error: unknown) => {
          if (this.stopped) return;
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
          this.stop();
        },
      );
  }

  /** @internal - Establish the dedicated WebSocket connection */
  private _connect(wsUrl: string): void {
    const proxyAgent = nodeProxyTransport.getWebSocketAgent(wsUrl);
    this.ws = new WebSocket(wsUrl, proxyAgent ? { agent: proxyAgent } : {});

    this.ws.on('open', () => {
      if (this.stopped) {
        this.ws?.close();
        return;
      }
      // Send subscription message
      this.ws?.send(JSON.stringify(this.subscribeMessage), (err?: Error) => {
        if (err) {
          this.emit('error', err);
          this.stop();
        }
      });
    });

    this.ws.on('message', (data: Data) => {
      if (this.stopped) return;
      try {
        const message: LogStreamMessage = JSON.parse(data.toString());
        if (message.error) {
          this.emit('error', new Error(message.error));
          return;
        }
        if (message.lines && message.lines.length > 0) {
          this.emit('lines', message.lines);
          for (const line of message.lines) {
            this.emit('line', line);
          }
        }
      } catch {
        // Ignore parse errors for non-JSON messages
      }
    });

    this.ws.on('error', (err: Error) => {
      if (!this.stopped) {
        this.emit('error', err);
      }
    });

    this.ws.on('close', () => {
      if (!this.stopped) {
        this.stopped = true;
        this.emit('close');
      }
      this.ws = null;
    });
  }
}
