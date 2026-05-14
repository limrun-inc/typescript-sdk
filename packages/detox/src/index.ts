import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { Ios } from '@limrun/api';
import type {
  AccessibilitySelector,
  ElementTreeNode,
  InstanceClient,
  ReverseTunnel,
} from '@limrun/api/ios-client';

export type DetoxLaunchMode = 'ForegroundIfRunning' | 'RelaunchIfRunning';

export type DetoxServerProcess = {
  process: ChildProcessWithoutNullStreams;
  port: number;
  stdout: string[];
  stderr: string[];
  stop: () => Promise<void>;
};

type LimrunDetoxInstanceClient = Pick<
  InstanceClient,
  | 'startReverseTunnel'
  | 'launchApp'
  | 'openUrl'
  | 'elementTree'
  | 'tapElement'
  | 'setElementValue'
  | 'pressKey'
  | 'typeText'
>;

export type DetoxRunPrepareOptions = {
  client: LimrunDetoxInstanceClient;
  sessionId?: string;
  mediatorLocalPort?: number;
  mediatorRemotePort?: number;
  version?: string;
  detoxLogLevel?: string;
  artifactDirectory?: string;
  cwd?: string;
  detoxBin?: string;
};

export type DetoxRunPrepareResult = {
  sessionId: string;
  detoxServerUrl: string;
  remoteDetoxServerUrl: string;
  version: string;
  server: DetoxServerProcess;
  tunnel: ReverseTunnel;
  artifactDirectory: string;
  cleanup: () => Promise<void>;
};

export type ExpoGoDetoxLaunchOptions = {
  client: LimrunDetoxInstanceClient;
  expoUrl: string;
  remoteDetoxServerUrl: string;
  sessionId: string;
  version?: string;
  bundleId?: string;
  launchMode?: Extract<DetoxLaunchMode, 'RelaunchIfRunning'>;
  expectedElementId?: string;
  expectedText?: string;
};

export type DetoxTestRunOptions = {
  configPath: string;
  configuration: string;
  sessionId: string;
  serverUrl: string;
  iosId: string;
  iosApiUrl?: string;
  iosToken?: string;
  artifactDirectory: string;
  detoxBin?: string;
  detoxLogLevel?: string;
  cwd?: string;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
};

export type DetoxTestRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
  summaryPath: string;
};

export async function prepareDetoxRun(options: DetoxRunPrepareOptions): Promise<DetoxRunPrepareResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sessionId = options.sessionId || `limrun-detox-${Date.now()}`;
  const mediatorLocalPort = options.mediatorLocalPort ?? (await getAvailableTcpPort());
  const mediatorRemotePort = options.mediatorRemotePort ?? 57091;
  const artifactDirectory = path.resolve(cwd, options.artifactDirectory || 'artifacts/limrun-detox');
  fs.mkdirSync(artifactDirectory, { recursive: true });

  let server: DetoxServerProcess | undefined;
  let tunnel: ReverseTunnel | undefined;
  try {
    server = await startDetoxServer({
      port: mediatorLocalPort,
      artifactDirectory,
      cwd,
      logLevel: options.detoxLogLevel ?? process.env['DETOX_LOGLEVEL'] ?? 'verbose',
      ...(options.detoxBin ? { detoxBin: options.detoxBin } : {}),
    });

    tunnel = await options.client.startReverseTunnel({
      remotePort: mediatorRemotePort,
      localPort: mediatorLocalPort,
      logLevel: 'info',
    });

    const preparedServer = server;
    const preparedTunnel = tunnel;
    const remoteDetoxServerUrl = `ws://${preparedTunnel.remoteAddress.address}:${preparedTunnel.remoteAddress.port}`;
    const version = options.version ?? resolveInstalledDetoxVersion(cwd);

    return {
      sessionId,
      detoxServerUrl: `ws://localhost:${mediatorLocalPort}`,
      remoteDetoxServerUrl,
      version,
      server: preparedServer,
      tunnel: preparedTunnel,
      artifactDirectory,
      cleanup: async () => {
        preparedTunnel.close();
        await preparedServer.stop();
      },
    };
  } catch (error) {
    tunnel?.close();
    await server?.stop().catch(() => {});
    throw error;
  }
}

export async function launchExpoGoDetoxApp(options: ExpoGoDetoxLaunchOptions): Promise<void> {
  const bundleId = options.bundleId || 'host.exp.Exponent';

  await options.client.launchApp(bundleId, {
    mode: options.launchMode || 'RelaunchIfRunning',
    runtime: {
      kind: 'detox',
      serverUrl: options.remoteDetoxServerUrl,
      sessionId: options.sessionId,
      ...(options.version ? { version: options.version } : {}),
    },
  });

  await openExpoProject(options.client, options.expoUrl, {
    ...(options.expectedElementId ? { expectedElementId: options.expectedElementId } : {}),
    ...(options.expectedText ? { expectedText: options.expectedText } : {}),
  });
  process.env['LIMRUN_DETOX_APP_PREPARED'] = 'true';
}

export async function launchExpoGoDetoxAppFromEnv(): Promise<void> {
  const apiUrl = requireEnv('LIMRUN_IOS_API_URL');
  const token = requireEnv('LIMRUN_IOS_TOKEN');
  const expoUrl = requireEnv('EXPO_URL');
  const remoteDetoxServerUrl = requireEnv('LIMRUN_DETOX_SERVER_URL');
  const sessionId = requireEnv('DETOX_SESSION_ID');
  const client = await Ios.createInstanceClient({
    apiUrl,
    token,
    logLevel: 'none',
  });

  try {
    await launchExpoGoDetoxApp({
      client,
      expoUrl,
      remoteDetoxServerUrl,
      sessionId,
      ...(process.env['DETOX_VERSION'] ? { version: process.env['DETOX_VERSION'] } : {}),
      ...(process.env['DETOX_BUNDLE_ID'] ? { bundleId: process.env['DETOX_BUNDLE_ID'] } : {}),
      ...(process.env['DETOX_EXPECTED_ELEMENT_ID'] ?
        { expectedElementId: process.env['DETOX_EXPECTED_ELEMENT_ID'] }
      : {}),
      ...(process.env['DETOX_EXPECTED_TEXT'] ? { expectedText: process.env['DETOX_EXPECTED_TEXT'] } : {}),
    });
  } finally {
    client.disconnect();
  }
}

export async function runDetoxTest(options: DetoxTestRunOptions): Promise<DetoxTestRunResult> {
  fs.mkdirSync(options.artifactDirectory, { recursive: true });
  const stdoutPath = path.join(options.artifactDirectory, 'detox.stdout.log');
  const stderrPath = path.join(options.artifactDirectory, 'detox.stderr.log');
  const summaryPath = path.join(options.artifactDirectory, 'detox.summary.json');

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const command = options.detoxBin ?? resolveLocalDetoxBin(cwd);
  const args = [
    'test',
    '-C',
    options.configPath,
    '-c',
    options.configuration,
    '--no-start',
    '--take-screenshots',
    'manual',
    '--artifacts-location',
    path.join(options.artifactDirectory, 'detox-artifacts'),
    '-l',
    options.detoxLogLevel ?? process.env['DETOX_LOGLEVEL'] ?? 'verbose',
  ];

  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...options.extraEnv,
      DETOX_ARTIFACTS_DIR: options.artifactDirectory,
      DETOX_SERVER: options.serverUrl,
      DETOX_SESSION_ID: options.sessionId,
      LIMRUN_IOS_ID: options.iosId,
      ...(options.iosApiUrl ? { LIMRUN_IOS_API_URL: options.iosApiUrl } : {}),
      ...(options.iosToken ? { LIMRUN_IOS_TOKEN: options.iosToken } : {}),
    },
  });

  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await waitForProcess(child, options.timeoutMs ?? 10 * 60_000);
  } finally {
    stdout.end();
    stderr.end();
  }

  fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  return {
    ...result,
    stdoutPath,
    stderrPath,
    summaryPath,
  };
}

export function resolveInstalledDetoxVersion(cwd = process.cwd()): string {
  const packageJsonPath = path.join(cwd, 'node_modules', 'detox', 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('Missing Detox version. Pass version or install detox in the current project.');
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
  if (!packageJson.version) {
    throw new Error(`Missing Detox version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

export async function startDetoxServer({
  port,
  artifactDirectory,
  cwd,
  detoxBin,
  logLevel,
}: {
  port: number;
  artifactDirectory: string;
  cwd: string;
  detoxBin?: string;
  logLevel?: string;
}): Promise<DetoxServerProcess> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await assertTcpPortAvailable(port);
  const child = spawn(
    detoxBin ?? resolveLocalDetoxBin(cwd),
    ['run-server', '-p', String(port), '-l', logLevel || 'verbose'],
    {
      cwd,
      env: process.env,
    },
  );
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout.push(text);
    process.stdout.write(text);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr.push(text);
    process.stderr.write(text);
  });

  try {
    await waitForTcpPort(child, port, 20_000, () => stderr.join(''));
  } catch (error) {
    await stopProcess(child).catch(() => {});
    throw error;
  }

  fs.writeFileSync(path.join(artifactDirectory, 'detox-server.pid'), String(child.pid ?? ''));

  return {
    process: child,
    port,
    stdout,
    stderr,
    stop: () => stopProcess(child),
  };
}

async function openExpoProject(
  client: LimrunDetoxInstanceClient,
  expoUrl: string,
  readiness: { expectedElementId?: string; expectedText?: string },
): Promise<void> {
  await waitForExpoGoShellOrApp(client, readiness, 30_000);

  for (let attempt = 0; attempt < 2; attempt++) {
    await client.openUrl(expoUrl);
    if (await waitForExpoProjectReady(client, readiness, 30_000)) {
      return;
    }
  }

  if (await enterExpoUrlManually(client, expoUrl)) {
    if (await waitForExpoProjectReady(client, readiness, 60_000)) {
      return;
    }
  }

  if (readiness.expectedElementId) {
    throw new Error(
      `Timed out waiting for element id '${readiness.expectedElementId}' after opening Expo URL`,
    );
  }
  if (readiness.expectedText) {
    throw new Error(`Timed out waiting for visible text '${readiness.expectedText}' after opening Expo URL`);
  }
  throw new Error('Expo URL did not leave the Expo Go home screen');
}

async function waitForExpoGoShellOrApp(
  client: LimrunDetoxInstanceClient,
  readiness: { expectedElementId?: string; expectedText?: string },
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tree = await client.elementTree();
    if (isAppReady(tree, readiness) || containsExpoGoHome(tree)) {
      return;
    }
    await sleep(500);
  }
}

async function waitForExpoProjectReady(
  client: LimrunDetoxInstanceClient,
  readiness: { expectedElementId?: string; expectedText?: string },
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tree = await client.elementTree();
    if (isAppReady(tree, readiness)) {
      return true;
    }
    if (containsExpoGoOpenPrompt(tree)) {
      const tapped = await tapExpoGoOpenButton(client);
      if (tapped) {
        await waitForExpoGoOpenPromptToDisappear(client, 5_000);
      }
      await sleep(500);
      continue;
    }
    if (
      !readiness.expectedElementId &&
      !readiness.expectedText &&
      !containsExpoGoHome(tree) &&
      !containsExpoGoOpenPrompt(tree)
    ) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function tapExpoGoOpenButton(client: LimrunDetoxInstanceClient): Promise<boolean> {
  const selectors: AccessibilitySelector[] = [
    { AXLabel: 'Open', type: 'Button' },
    { title: 'Open', type: 'Button' },
    { AXLabel: 'Open' },
    { title: 'Open' },
  ];

  for (const selector of selectors) {
    try {
      await client.tapElement(selector);
      return true;
    } catch {
      // Try the next accessibility shape; iOS alerts are not always exposed consistently.
    }
  }
  return false;
}

async function enterExpoUrlManually(client: LimrunDetoxInstanceClient, expoUrl: string): Promise<boolean> {
  await waitForExpoGoHome(client, 15_000);
  try {
    await client.tapElement({ AXLabel: 'Enter URL manually' });
  } catch {
    try {
      await client.tapElement({ AXLabelContains: 'Enter URL manually' });
    } catch {
      return false;
    }
  }

  await sleep(500);
  try {
    await client.setElementValue(expoUrl, { type: 'TextField' });
    await client.pressKey('enter');
  } catch {
    await client.typeText(expoUrl, true);
  }
  return true;
}

async function waitForExpoGoHome(client: LimrunDetoxInstanceClient, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tree = await client.elementTree();
    if (containsExpoGoHome(tree)) {
      return;
    }
    await sleep(500);
  }
}

async function waitForExpoGoOpenPromptToDisappear(
  client: LimrunDetoxInstanceClient,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tree = await client.elementTree();
    if (!containsExpoGoOpenPrompt(tree)) {
      return;
    }
    await sleep(500);
  }
}

function containsElementId(node: ElementTreeNode, id: string): boolean {
  if (node.AXUniqueId === id) {
    return true;
  }
  return (node.children ?? []).some((child) => containsElementId(child, id));
}

function isAppReady(
  tree: ElementTreeNode[],
  readiness: { expectedElementId?: string; expectedText?: string },
): boolean {
  if (readiness.expectedElementId) {
    if (tree.some((node) => containsElementId(node, readiness.expectedElementId!))) {
      return true;
    }
  }
  if (readiness.expectedText) {
    if (tree.some((node) => containsElementText(node, readiness.expectedText!))) {
      return true;
    }
  }
  return false;
}

function containsExpoGoHome(tree: ElementTreeNode[]): boolean {
  return (
    tree.some((node) => containsElementText(node, 'Expo Go')) &&
    (tree.some((node) => containsElementText(node, 'Development servers')) ||
      tree.some((node) => containsElementText(node, 'Enter URL manually')))
  );
}

function containsExpoGoOpenPrompt(tree: ElementTreeNode[]): boolean {
  return (
    tree.some((node) => containsElementText(node, 'Expo Go')) &&
    (tree.some((node) => containsElementText(node, 'Open in "Expo Go"')) ||
      tree.some((node) => containsElementText(node, 'Open in “Expo Go”'))) &&
    !containsExpoGoHome(tree)
  );
}

function containsElementText(node: ElementTreeNode, text: string): boolean {
  const needle = text.toLowerCase();
  const values = [node.AXLabel, node.title, node.AXValue].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (values.some((value) => value.toLowerCase().includes(needle))) {
    return true;
  }
  return (node.children ?? []).some((child) => containsElementText(child, text));
}

function resolveLocalDetoxBin(cwd: string): string {
  const detoxBin = path.join(cwd, 'node_modules', '.bin', 'detox');
  if (!fs.existsSync(detoxBin)) {
    throw new Error(
      `Missing local Detox binary at ${detoxBin}. Run your package manager install first or pass detoxBin.`,
    );
  }
  return detoxBin;
}

function getAvailableTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolve(address.port);
        } else {
          reject(new Error('Failed to allocate a local TCP port'));
        }
      });
    });
  });
}

function assertTcpPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Local Detox mediator port ${port} is already in use`));
      } else {
        reject(error);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve());
    });
  });
}

function waitForTcpPort(
  child: ChildProcessWithoutNullStreams,
  port: number,
  timeoutMs: number,
  diagnostics: () => string,
): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      settled = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const stderr = diagnostics().trim();
      fail(
        new Error(
          `detox run-server exited before listening on port ${port} (code=${code}, signal=${signal})${
            stderr ? `: ${stderr}` : ''
          }`,
        ),
      );
    };
    const onError = (error: Error) => fail(error);

    child.once('exit', onExit);
    child.once('error', onError);

    const tryConnect = () => {
      if (settled) return;
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        cleanup();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          fail(new Error(`Timed out waiting for detox run-server on port ${port}`));
        } else {
          retryTimer = setTimeout(tryConnect, 250);
        }
      });
    };
    tryConnect();
  });
}

function waitForProcess(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopProcess(child).catch(() => {});
      reject(new Error(`Detox test timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    child.once('exit', (code, signal) => {
      finish(() => resolve({ code, signal }));
    });
    child.once('error', (error) => {
      finish(() => reject(error));
    });
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(3000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
