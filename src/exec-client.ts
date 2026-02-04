/**
 * Client for executing commands on limbuild server with streaming output.
 */

// =============================================================================
// Types
// =============================================================================

export type ExecRequest = {
  command: 'xcodebuild';
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

type BuildStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

type BuildRecord = {
  id: string;
  status: BuildStatus;
  exitCode?: number;
  error?: string;
};

type DataListener = (line: string) => void;
type ErrorListener = (err: Error) => void;
type EndListener = () => void;

/**
 * A simple EventEmitter-like interface for stdout streaming.
 */
class StreamEmitter {
  private dataListeners: DataListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private endListeners: EndListener[] = [];
  private ended = false;

  on(event: 'data', listener: DataListener): this;
  on(event: 'error', listener: ErrorListener): this;
  on(event: 'end', listener: EndListener): this;
  on(event: 'data' | 'error' | 'end', listener: DataListener | ErrorListener | EndListener): this {
    if (event === 'data') {
      this.dataListeners.push(listener as DataListener);
    } else if (event === 'error') {
      this.errorListeners.push(listener as ErrorListener);
    } else if (event === 'end') {
      this.endListeners.push(listener as EndListener);
    }
    return this;
  }

  emit(event: 'data', line: string): void;
  emit(event: 'error', err: Error): void;
  emit(event: 'end'): void;
  emit(event: 'data' | 'error' | 'end', arg?: string | Error): void {
    if (event === 'data' && typeof arg === 'string') {
      for (const l of this.dataListeners) l(arg);
    } else if (event === 'error' && arg instanceof Error) {
      for (const l of this.errorListeners) l(arg);
    } else if (event === 'end' && !this.ended) {
      this.ended = true;
      for (const l of this.endListeners) l();
    }
  }
}

/**
 * A ChildProcess-like object that can be awaited for the result
 * and provides stdout streaming via event listeners.
 */
export interface ExecChildProcess extends Promise<ExecResult> {
  /** Stream of stdout/stderr lines from the build */
  stdout: {
    on(event: 'data', listener: (line: string) => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
    on(event: 'end', listener: () => void): void;
  };
  /** Cancel the running build */
  kill: () => Promise<void>;
  /** The exec/build ID (available after exec starts) */
  execId: string | undefined;
}

// =============================================================================
// Implementation
// =============================================================================

const noopLog = (_level: 'debug' | 'info' | 'warn' | 'error', _msg: string) => {};

/**
 * Execute a command on the limbuild server.
 * Returns a ChildProcess-like object that can be awaited and provides stdout streaming.
 *
 * @example
 * const proc = exec({ command: 'xcodebuild' }, { apiUrl: '...', token: '...' });
 * proc.stdout.on('data', (line) => console.log(line));
 * const { exitCode } = await proc;
 */
export function exec(request: ExecRequest, options: ExecOptions): ExecChildProcess {
  const log = options.log ?? noopLog;
  const stdout = new StreamEmitter();
  let execId: string | undefined;
  let abortController: AbortController | null = null;
  let killed = false;

  const kill = async (): Promise<void> => {
    killed = true;
    if (abortController) {
      abortController.abort();
    }
    try {
      await fetch(`${options.apiUrl}/build/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
        },
      });
      log('info', 'Build cancelled');
    } catch (err) {
      log('warn', `Failed to cancel build: ${err}`);
    }
  };

  const run = async (): Promise<ExecResult> => {
    // 1. Trigger the build via POST /exec
    log('debug', `POST ${options.apiUrl}/exec`);
    const execRes = await fetch(`${options.apiUrl}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(request),
    });

    if (!execRes.ok) {
      const text = await execRes.text();
      const err = new Error(`exec failed: ${execRes.status} ${text}`);
      stdout.emit('error', err);
      stdout.emit('end');
      throw err;
    }

    const execData = (await execRes.json()) as { execId: string };
    execId = execData.execId;
    log('info', `Build started: ${execId}`);

    // 2. Connect to SSE for log streaming
    abortController = new AbortController();
    const eventsUrl = `${options.apiUrl}/events`;
    log('debug', `GET ${eventsUrl} (SSE)`);

    let sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let buildCompleted = false;
    let finalResult: ExecResult | null = null;

    const connectSSE = async () => {
      try {
        const sseRes = await fetch(eventsUrl, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${options.token}`,
          },
          signal: abortController!.signal,
        });

        if (!sseRes.ok || !sseRes.body) {
          log('warn', `SSE connection failed: ${sseRes.status}`);
          return;
        }

        sseReader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!buildCompleted && !killed) {
          const { done, value } = await sseReader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          let currentEvent = '';
          let currentData = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6);
            } else if (line === '' && currentEvent && currentData) {
              // Process complete event
              if (currentEvent === 'log' && currentData.startsWith(`${execId}|`)) {
                const logLine = currentData.slice(execId!.length + 1);
                stdout.emit('data', logLine);
              } else if (currentEvent === 'build' && currentData.startsWith(execId!)) {
                // Build status event: "<buildId> succeeded|failed|cancelled"
                const statusPart = currentData.slice(execId!.length + 1).toLowerCase();
                if (statusPart === 'succeeded' || statusPart === 'failed' || statusPart === 'cancelled') {
                  buildCompleted = true;
                  log('debug', `Build event: ${statusPart}`);
                }
              }
              currentEvent = '';
              currentData = '';
            }
          }
        }
      } catch (err) {
        if (!killed && !(err instanceof Error && err.name === 'AbortError')) {
          log('warn', `SSE error: ${err}`);
        }
      } finally {
        if (sseReader) {
          try {
            sseReader.releaseLock();
          } catch {
            // ignore
          }
        }
      }
    };

    // Start SSE in background
    const ssePromise = connectSSE();

    // 3. Poll for build completion (backup to SSE events)
    const pollForCompletion = async (): Promise<ExecResult> => {
      const pollInterval = 1000;
      const maxAttempts = 3600; // 1 hour max

      for (let attempt = 0; attempt < maxAttempts && !killed; attempt++) {
        try {
          const buildRes = await fetch(`${options.apiUrl}/builds/${execId}`, {
            headers: {
              Authorization: `Bearer ${options.token}`,
            },
          });

          if (buildRes.ok) {
            const build = (await buildRes.json()) as BuildRecord;
            log('debug', `Build status: ${build.status}`);

            if (build.status === 'SUCCEEDED' || build.status === 'FAILED' || build.status === 'CANCELLED') {
              buildCompleted = true;
              return {
                exitCode: build.exitCode ?? (build.status === 'SUCCEEDED' ? 0 : 1),
                execId: execId!,
                status: build.status,
              };
            }
          }
        } catch (err) {
          log('warn', `Poll error: ${err}`);
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      // Timeout
      buildCompleted = true;
      return {
        exitCode: 1,
        execId: execId!,
        status: 'FAILED',
      };
    };

    // Wait for completion
    finalResult = await pollForCompletion();

    // Cleanup SSE connection
    if (abortController) {
      abortController.abort();
    }
    await ssePromise.catch(() => {});

    stdout.emit('end');
    log('info', `Build finished: ${finalResult.status} (exit ${finalResult.exitCode})`);
    return finalResult;
  };

  // Create the promise
  const promise = run();

  // Create the ExecChildProcess object
  const execChildProcess = promise as ExecChildProcess;
  Object.defineProperty(execChildProcess, 'stdout', {
    value: {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        stdout.on(event as 'data', listener as DataListener);
      },
    },
    writable: false,
  });
  Object.defineProperty(execChildProcess, 'kill', {
    value: kill,
    writable: false,
  });
  Object.defineProperty(execChildProcess, 'execId', {
    get: () => execId,
  });

  return execChildProcess;
}
