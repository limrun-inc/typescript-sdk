import { EventEmitter } from 'events';
import { nodeProxyTransport } from './internal/proxy-transport';
import { streamSessionEntries } from './internal/session-stream';

/**
 * Handle for one logcat invocation on an Android instance.
 *
 * The instance runs `logcat` with the caller's arguments and serves its
 * output over a per-run SSE stream (same machinery as session capture
 * streams), batched every ~500ms. Lines arrive via 'lines'/'line'; 'exit'
 * fires once with logcat's exit code, or -1 when stopped or the stream is
 * lost.
 */
export interface LogcatProcessEvents {
  lines: (lines: string[]) => void;
  line: (line: string) => void;
  error: (error: Error) => void;
  exit: (exitCode: number) => void;
}

/** @internal - One frame of the per-run logcat SSE stream */
type LogcatEntry = {
  ts: number;
  lines?: string[];
  error?: string;
  exitCode?: number;
};

export class LogcatProcess extends EventEmitter {
  private stopStream: (() => void) | null = null;
  private runId: string | null = null;
  private stopped = false;
  private exited = false;
  private readonly exitPromise: Promise<number>;
  private settleExit!: (code: number) => void;

  /** @internal */
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
    args: string[],
  ) {
    super();
    this.exitPromise = new Promise((resolve) => {
      this.settleExit = resolve;
    });
    void this.start(args);
  }

  override on<E extends keyof LogcatProcessEvents>(event: E, listener: LogcatProcessEvents[E]): this {
    return super.on(event, listener as any);
  }

  override once<E extends keyof LogcatProcessEvents>(event: E, listener: LogcatProcessEvents[E]): this {
    return super.once(event, listener as any);
  }

  override off<E extends keyof LogcatProcessEvents>(event: E, listener: LogcatProcessEvents[E]): this {
    return super.off(event, listener as any);
  }

  /** Resolves with logcat's exit code; -1 when stopped or the stream was lost. */
  wait(): Promise<number> {
    return this.exitPromise;
  }

  /** Stop the remote logcat process and close the stream. */
  stop(): void {
    if (this.stopped || this.exited) return;
    this.stopped = true;
    this.deleteRun(this.runId);
    this.finish(-1);
  }

  private deleteRun(runId: string | null): void {
    if (!runId) return;
    // Fire and forget: the server's idle sweep reaps the run if this is lost.
    void nodeProxyTransport
      .fetch(`${this.apiUrl}/logcat/${runId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.token}` },
      })
      .catch(() => {});
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.stopStream?.();
    this.stopStream = null;
    this.settleExit(code);
    this.emit('exit', code);
  }

  private fail(error: Error): void {
    if (this.exited) return;
    // The remote process must not outlive a lost stream; the idle sweep is
    // only the fallback for when this delete is lost too.
    this.deleteRun(this.runId);
    this.emit('error', error);
    this.finish(-1);
  }

  private async start(args: string[]): Promise<void> {
    let id: string;
    try {
      const response = await nodeProxyTransport.fetch(`${this.apiUrl}/logcat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ args }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`logcat failed to start: HTTP ${response.status}${text ? ` ${text.trim()}` : ''}`);
      }
      const data = (await response.json()) as { id?: string };
      if (!data.id) {
        throw new Error('logcat failed to start: server returned no run id');
      }
      id = data.id;
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (this.stopped) {
      // stop() raced the POST; kill the run it just created.
      this.deleteRun(id);
      return;
    }
    this.runId = id;
    this.stopStream = streamSessionEntries<LogcatEntry>({
      url: `${this.apiUrl}/logcat/${id}/events`,
      token: this.token,
      onEntry: (entry) => {
        if (entry.lines && entry.lines.length > 0) {
          this.emit('lines', entry.lines);
          for (const line of entry.lines) {
            this.emit('line', line);
          }
        }
        if (entry.error) {
          this.emit('error', new Error(entry.error));
        }
        if (typeof entry.exitCode === 'number') {
          this.finish(entry.exitCode);
        }
      },
      onError: (error) => this.fail(error),
    });
  }
}
