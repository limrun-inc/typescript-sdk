import { EventEmitter } from 'events';
import { WebSocket, Data } from 'ws';
import { nodeProxyTransport } from './internal/proxy-transport';

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
 * Log stream with dedicated WebSocket connection.
 * Each LogStream opens its own WebSocket to isolate log traffic from signaling.
 */
export class LogStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptionId: string;
  private stopped = false;
  private terminateMessageType: string;

  /** @internal */
  constructor(
    private wsUrl: string,
    private subscribeMessage: object,
    terminateMessageType: string,
    subscriptionId: string,
  ) {
    super();
    this.terminateMessageType = terminateMessageType;
    this.subscriptionId = subscriptionId;
    this._connect();
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

  /** @internal - Establish the dedicated WebSocket connection */
  private _connect(): void {
    const proxyAgent = nodeProxyTransport.getWebSocketAgent(this.wsUrl);
    this.ws = new WebSocket(this.wsUrl, proxyAgent ? { agent: proxyAgent } : {});

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
