/**
 * Client for executing commands on limbuild server with streaming output.
 *
 * The interface is designed to be similar to Node.js's child_process.spawn()
 * for familiarity and ease of extension.
 */

import { Agent, EventSource, type Dispatcher } from 'undici';

// =============================================================================
// Types
// =============================================================================

export type ExecRequest = {
  command: 'xcodebuild';
  xcodebuild?: {
    workspace?: string;
    project?: string;
    scheme?: string;
  };
};

export type ExecOptions = {
  apiUrl: string;
  token: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
};

export type ExecResult = {
  exitCode: number;
  execId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
};

type DataListener = (chunk: string) => void;
type CloseListener = () => void;
type ExitListener = (code: number) => void;

/**
 * A Readable-like stream interface, similar to Node.js stream.Readable.
 * Emits 'data' for each chunk and 'close' when the stream ends.
 */
export class ReadableStream {
  private dataListeners: DataListener[] = [];
  private closeListeners: CloseListener[] = [];
  private closed = false;

  on(event: 'data', listener: DataListener): this;
  on(event: 'close', listener: CloseListener): this;
  on(event: 'data' | 'close', listener: DataListener | CloseListener): this {
    if (event === 'data') {
      this.dataListeners.push(listener as DataListener);
    } else if (event === 'close') {
      this.closeListeners.push(listener as CloseListener);
    }
    return this;
  }

  /** @internal */
  emit(event: 'data', chunk: string): void;
  emit(event: 'close'): void;
  emit(event: 'data' | 'close', arg?: string): void {
    if (event === 'data' && typeof arg === 'string') {
      for (const l of this.dataListeners) l(arg);
    } else if (event === 'close' && !this.closed) {
      this.closed = true;
      for (const l of this.closeListeners) l();
    }
  }
}

/**
 * A ChildProcess-like object similar to Node.js's ChildProcess.
 *
 * Implements PromiseLike so it can be awaited directly.
 *
 * @example
 * // Stream-based (like Node.js spawn)
 * const proc = exec({ command: 'xcodebuild' }, options);
 * proc.stdout.on('data', (chunk) => process.stdout.write(chunk));
 * proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
 * proc.on('exit', (code) => console.log(`Exited with code ${code}`));
 *
 * // Promise-based (can be awaited)
 * const { exitCode, status } = await proc;
 */
export class ExecChildProcess implements PromiseLike<ExecResult> {
  /** Stdout stream - emits 'data' and 'close' events */
  readonly stdout = new ReadableStream();

  /** Stderr stream - emits 'data' and 'close' events */
  readonly stderr = new ReadableStream();

  /** The remote process/build identifier (similar to pid in Node.js) */
  execId: string | undefined;

  private readonly resultPromise: Promise<ExecResult>;
  private readonly exitListeners: ExitListener[] = [];
  private abortController: AbortController | null = null;
  private sseConnection: EventSource | null = null;
  private killed = false;
  private readonly options: ExecOptions;
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

  constructor(request: ExecRequest, options: ExecOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.resultPromise = this.run(request);
  }

  /** Implement PromiseLike so this object can be awaited */
  then<TResult1 = ExecResult, TResult2 = never>(
    onfulfilled?: ((value: ExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.resultPromise.then(onfulfilled, onrejected);
  }

  /** Catch errors */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<ExecResult | TResult> {
    return this.resultPromise.catch(onrejected);
  }

  /** Finally handler */
  finally(onfinally?: (() => void) | null): Promise<ExecResult> {
    return this.resultPromise.finally(onfinally);
  }

  /** Listen for process events */
  on(event: 'exit', listener: ExitListener): this {
    if (event === 'exit') {
      this.exitListeners.push(listener);
    }
    return this;
  }

  /** Send a signal to terminate the process */
  async kill(): Promise<void> {
    this.killed = true;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.sseConnection) {
      this.sseConnection.close();
      this.sseConnection = null;
    }
    if (!this.execId) {
      this.log('warn', 'Failed to cancel build: execId is not set');
      return;
    }
    try {
      await fetch(`${this.options.apiUrl}/exec/${this.execId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
        },
      });
      this.log('info', 'Build cancelled');
    } catch (err) {
      this.log('warn', `Failed to cancel build: ${err}`);
    }
  }

  private async run(request: ExecRequest): Promise<ExecResult> {
    const { log } = this;
    const { apiUrl, token } = this.options;

    // 1. Trigger the build via POST /exec
    log('debug', `POST ${apiUrl}/exec`);
    const execRes = await fetch(`${apiUrl}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });

    if (!execRes.ok) {
      const text = await execRes.text();
      throw new Error(`exec failed: ${execRes.status} ${text}`);
    }

    const execData = (await execRes.json()) as { execId: string };
    this.execId = execData.execId;
    log('info', `Build started: ${this.execId}`);

    // 2. Connect to SSE for log streaming and completion detection
    this.abortController = new AbortController();
    const eventsUrl = `${apiUrl}/exec/${this.execId}/events`;
    log('debug', `GET ${eventsUrl} (SSE)`);

    // Promise that resolves when build completes (via exitCode event)
    let sseCompletionResolve: ((exitCode: number) => void) | null = null;
    const sseCompletionPromise = new Promise<number>((resolve) => {
      sseCompletionResolve = resolve;
    });

    const ssePromise = this.connectSSE(eventsUrl, sseCompletionResolve);

    // Wait for SSE to signal completion (with timeout fallback)
    const timeoutMs = 3600 * 1000; // 1 hour max
    let exitCode: number;
    try {
      exitCode = await Promise.race([
        sseCompletionPromise,
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), timeoutMs)),
      ]);
    } catch {
      log('warn', 'SSE completion timeout');
      exitCode = 1;
    }

    // Cleanup SSE connection
    if (this.abortController) {
      this.abortController.abort();
    }
    await ssePromise.catch(() => {});

    // Emit close events on streams
    this.stdout.emit('close');
    this.stderr.emit('close');

    // Emit exit event
    for (const listener of this.exitListeners) {
      listener(exitCode);
    }

    // Determine status from exit code
    const status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' =
      exitCode === 0 ? 'SUCCEEDED'
      : exitCode === -1 ? 'CANCELLED'
      : 'FAILED';

    const result: ExecResult = {
      exitCode,
      execId: this.execId!,
      status,
    };

    this.log('info', `Build finished: ${result.status} (exit ${result.exitCode})`);
    return result;
  }

  private async connectSSE(
    eventsUrl: string,
    onComplete: ((exitCode: number) => void) | null,
  ): Promise<void> {
    return new Promise((resolve) => {
      const authHeader = `Bearer ${this.options.token}`;
      class CustomHeaderAgent extends Agent {
        override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
          if (opts.headers) {
            (opts.headers as Record<string, string>)['Authorization'] = authHeader;
          } else {
            opts.headers = { Authorization: authHeader };
          }
          return super.dispatch(opts, handler);
        }
      }

      let resolved = false;
      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        this.sseConnection?.close();
        this.sseConnection = null;
        resolve();
      };

      try {
        const eventSource = new EventSource(eventsUrl, { dispatcher: new CustomHeaderAgent() });
        this.sseConnection = eventSource;

        const readData = (event: { data?: unknown }): string => {
          if (typeof event.data === 'string') return event.data;
          if (event.data === undefined || event.data === null) return '';
          return String(event.data);
        };

        eventSource.addEventListener('stdout', (event) => {
          this.stdout.emit('data', readData(event as { data?: unknown }));
        });
        eventSource.addEventListener('stderr', (event) => {
          this.stderr.emit('data', readData(event as { data?: unknown }));
        });
        eventSource.addEventListener('exitCode', (event) => {
          const data = readData(event as { data?: unknown });
          const exitCode = parseInt(data, 10);
          if (Number.isNaN(exitCode)) {
            this.log('warn', `SSE exitCode event has invalid data: ${data}`);
            return;
          }
          this.log('debug', `Build completed via SSE: exitCode=${exitCode}`);
          onComplete?.(exitCode);
          resolveOnce();
        });
        eventSource.onerror = (err) => {
          if (!this.killed) {
            this.log('warn', `SSE error: ${err}`);
          }
        };

        const abortSignal = this.abortController?.signal;
        if (abortSignal) {
          abortSignal.addEventListener(
            'abort',
            () => {
              resolveOnce();
            },
            { once: true },
          );
        }
      } catch (err) {
        if (!this.killed) {
          this.log('warn', `SSE setup failed: ${err}`);
        }
        resolveOnce();
      }
    });
  }
}

/**
 * Execute a command on the limbuild server.
 * Returns a ChildProcess-like object with stdout/stderr streams.
 *
 * @example
 * const proc = exec({ command: 'xcodebuild' }, { apiUrl: '...', token: '...' });
 *
 * // Stream output
 * proc.stdout.on('data', (chunk) => console.log('[stdout]', chunk));
 * proc.stderr.on('data', (chunk) => console.error('[stderr]', chunk));
 *
 * // Wait for completion
 * const { exitCode, status } = await proc;
 */
export function exec(request: ExecRequest, options: ExecOptions): ExecChildProcess {
  return new ExecChildProcess(request, options);
}
