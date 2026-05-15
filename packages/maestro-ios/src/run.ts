import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Ios } from '@limrun/api';
import { createBridgeServer, listen, type BridgeServer, type IosClient } from './bridge';
import { assertJava17OnPath } from './java';
import type { RunOptions } from './types';

const runnerJarPath = path.resolve(__dirname, '..', 'runner', 'build', 'libs', 'limrun-maestro-ios-runner.jar');
const defaultTimeoutMs = 10 * 60 * 1000;

export type RunResult = {
  artifactsDir: string;
  screenshotsDir: string;
  status: 'passed';
};

type RunSummary = {
  artifactsDir: string;
  error?: string;
  screenshotsDir: string;
  stderrTail?: string[];
  status: 'passed' | 'failed';
};

export async function runMaestroIos(options: RunOptions): Promise<RunResult> {
  const flowPath = path.resolve(options.flowPath);
  const artifactsDir = path.resolve(options.artifactsDir);
  const screenshotsDir = path.join(artifactsDir, 'screenshots');
  const logsDir = path.join(artifactsDir, 'logs');

  if (!fs.existsSync(flowPath)) {
    throw new Error(`Maestro flow does not exist: ${flowPath}`);
  }
  if (!fs.existsSync(runnerJarPath)) {
    throw new Error(`Packaged Maestro runner JAR is missing: ${runnerJarPath}. Run npm run build before using this package from source.`);
  }

  assertJava17OnPath();
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const abortController = new AbortController();
  const signalCleanup = installSignalHandlers(abortController);
  let child: ChildProcess | undefined;
  let bridge: BridgeServer | undefined;
  let ios: IosClient | undefined;
  let runError: unknown;
  const stderrPath = path.join(logsDir, 'runner.stderr.log');

  try {
    ios = await Ios.createInstanceClient({
      apiUrl: options.apiUrl,
      token: options.token,
      logLevel: 'info',
    });
    console.log(`Connected to Limrun iOS device ${ios.deviceInfo.udid}`);
    // SIGINT/SIGTERM can arrive before the Java runner exists; honor it before spawning.
    throwIfAborted(abortController.signal);
    bridge = createBridgeServer(ios);
    await listen(bridge);
    // Avoid starting Maestro after a user already requested shutdown during bridge setup.
    throwIfAborted(abortController.signal);
    const bridgeUrl = bridge.url();
    console.log(`Bridge listening at ${bridgeUrl}`);
    console.log(`Running Maestro flow: ${flowPath}`);

    const run = runRunner({
      bridgeUrl,
      deviceId: ios.deviceInfo.udid,
      flowPath,
      logsDir,
      screenshotsDir,
      signal: abortController.signal,
      timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
      onChild: (nextChild) => {
        child = nextChild;
      },
    });

    await run;
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    signalCleanup();

    const cleanupWarnings: string[] = [];
    try {
      await bridge?.close();
    } catch (error) {
      cleanupWarnings.push(`Bridge cleanup failed: ${errorMessage(error)}`);
    }

    try {
      ios?.disconnect();
    } catch (error) {
      cleanupWarnings.push(`iOS disconnect failed: ${errorMessage(error)}`);
    }

    // Always leave CI-readable breadcrumbs, even when the runner or cleanup fails.
    writeSummary(artifactsDir, {
      artifactsDir,
      screenshotsDir,
      status: runError ? 'failed' : 'passed',
      ...(runError ? { error: errorMessage(runError), stderrTail: readLastLines(stderrPath, 30) } : {}),
      ...(cleanupWarnings.length > 0 ? { stderrTail: [...(runError ? readLastLines(stderrPath, 30) : []), ...cleanupWarnings] } : {}),
    });
  }

  const result = {
    artifactsDir,
    screenshotsDir,
    status: 'passed' as const,
  };
  console.log('\nLimrun Maestro complete');
  console.log(`Artifacts: ${relativePath(artifactsDir)}`);
  console.log(`Screenshots: ${relativePath(screenshotsDir)}`);
  return result;
}

type RunRunnerOptions = {
  bridgeUrl: string;
  deviceId: string;
  flowPath: string;
  logsDir: string;
  onChild: (child: ChildProcess) => void;
  screenshotsDir: string;
  signal: AbortSignal;
  timeoutMs: number;
};

function runRunner(options: RunRunnerOptions): Promise<void> {
  const stdoutPath = path.join(options.logsDir, 'runner.stdout.log');
  const stderrPath = path.join(options.logsDir, 'runner.stderr.log');
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  let timeout: NodeJS.Timeout | undefined;
  let logStreamsClosed = false;

  const closeLogStreams = () => {
    if (logStreamsClosed) {
      return;
    }
    logStreamsClosed = true;
    stdout.end();
    stderr.end();
  };

  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      closeLogStreams();
      reject(new Error('Maestro runner interrupted'));
      return;
    }

    const child = spawn(
      'java',
      [
        '-jar',
        runnerJarPath,
        '--bridge-url',
        options.bridgeUrl,
        '--device-id',
        options.deviceId,
        '--flow',
        options.flowPath,
        '--screenshots-dir',
        options.screenshotsDir,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    options.onChild(child);
    let terminationReason: Error | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let exited = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr.write(chunk);
    });

    const abort = (reason: Error) => {
      terminationReason = reason;
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      // Wait for the JVM to exit before outer cleanup tears down the bridge underneath it.
      forceKillTimeout = setTimeout(() => {
        if (!exited) {
          child.kill('SIGKILL');
        }
      }, 5_000);
    };

    const onAbort = () => abort(new Error('Maestro runner interrupted'));
    options.signal.addEventListener('abort', onAbort, { once: true });

    timeout = setTimeout(() => {
      abort(new Error(`Maestro runner timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.on('error', (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      options.signal.removeEventListener('abort', onAbort);
      closeLogStreams();
      reject(error);
    });
    child.on('close', (code, signal) => {
      exited = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      options.signal.removeEventListener('abort', onAbort);
      closeLogStreams();
      if (terminationReason) {
        reject(terminationReason);
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Maestro runner exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function installSignalHandlers(controller: AbortController): () => void {
  const handler = () => controller.abort();
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Maestro runner interrupted');
  }
}

function writeSummary(artifactsDir: string, result: RunSummary): void {
  fs.writeFileSync(path.join(artifactsDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLastLines(filePath: string, limit: number): string[] {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - limit));
  } catch {
    return [];
  }
}

function relativePath(targetPath: string): string {
  const relative = path.relative(process.cwd(), targetPath);
  return relative.startsWith('..') ? targetPath : relative || '.';
}
