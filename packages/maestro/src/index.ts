import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';

import { Ios, Limrun } from '@limrun/api';
import type { InstanceClient, InstalledApp } from '@limrun/api/ios-client';
import type { IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

const RUNNER_BUNDLE_ID = 'dev.mobile.maestro-driver-iosUITests.xctrunner';
const DEFAULT_MAESTRO_BIN = 'maestro';
const DEFAULT_DRIVER_PORT = 7001;
const DEFAULT_RUNNER_PORT = 22087;
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000;

export type MaestroRunnerAsset = {
  name: string;
  signedDownloadUrl?: string;
};

export type MaestroIosInstance = {
  metadata: {
    id: string;
  };
  status: {
    apiUrl?: string;
    token: string;
    signedStreamUrl?: string;
    targetHttpPortUrlPrefix?: string;
  };
};

export type LimrunMaestroApi = {
  assets: {
    list: (query: {
      includeAppStore?: boolean;
      includeDownloadUrl?: boolean;
      nameFilter?: string;
    }) => Promise<MaestroRunnerAsset[]>;
    getOrUpload?: (body: { path: string; name?: string }) => Promise<MaestroRunnerAsset>;
  };
  iosInstances: {
    create: (body: any) => Promise<MaestroIosInstance>;
    delete: (id: string) => Promise<unknown>;
  };
};

type LimrunMaestroClient = Pick<
  InstanceClient,
  'deviceInfo' | 'installApp' | 'listApps' | 'simctl' | 'syncApp' | 'disconnect'
>;

export type PrepareMaestroRunOptions = {
  limrun: LimrunMaestroApi;
  instance: MaestroIosInstance;
  client?: LimrunMaestroClient;
  maestroBin?: string;
  maestroVersion?: string;
  driverPort?: number;
  runnerPort?: number;
  cwd?: string;
};

export type PreparedMaestroRun = {
  instance: MaestroIosInstance;
  client: LimrunMaestroClient;
  udid: string;
  maestroBin: string;
  maestroVersion: string;
  runnerAssetName: string;
  driverPort: number;
  runnerPort: number;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

export type RunMaestroTestOptions = {
  prepared: PreparedMaestroRun;
  flowPath?: string;
  flowPaths?: string[];
  outputDir?: string;
  env?: Record<string, string>;
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
};

export type RunMaestroTestResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type RunMaestroOnLimrunOptions = {
  apiKey?: string;
  limrun?: LimrunMaestroApi;
  maestroBin?: string;
  maestroVersion?: string;
  flowPath?: string;
  flowPaths?: string[];
  outputDir?: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  keepInstance?: boolean;
  reuseIfExists?: boolean;
  displayName?: string;
  labels?: Record<string, string>;
  region?: string;
  model?: 'iphone' | 'ipad' | 'watch';
  initialAssets?: string[];
};

export type RunMaestroOnLimrunResult = RunMaestroTestResult & {
  instance: MaestroIosInstance;
  keptInstance: boolean;
};

type SimctlResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ProxyServer = {
  port: number;
  close: () => Promise<void>;
};

type ShimServer = {
  url: string;
  close: () => Promise<void>;
};

export function runnerAssetNameForMaestroVersion(version: string): string {
  return `appstore/maestro-ios-runner-${version}.tar.gz`;
}

export async function prepareMaestroRun(options: PrepareMaestroRunOptions): Promise<PreparedMaestroRun> {
  const maestroBin = options.maestroBin ?? DEFAULT_MAESTRO_BIN;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maestroVersion = options.maestroVersion ?? resolveMaestroVersion({ maestroBin, cwd });
  const runnerAssetName = runnerAssetNameForMaestroVersion(maestroVersion);
  const runnerAsset = await resolveRunnerAsset(options.limrun, runnerAssetName);
  const driverPort = options.driverPort ?? DEFAULT_DRIVER_PORT;
  const runnerPort = options.runnerPort ?? DEFAULT_RUNNER_PORT;

  assertInstanceReady(options.instance);
  await assertTcpPortAvailable(driverPort);

  let ownsClient = false;
  const client =
    options.client ??
    (await Ios.createInstanceClient({
      apiUrl: options.instance.status.apiUrl!,
      token: options.instance.status.token,
      logLevel: 'none',
    }));
  if (!options.client) {
    ownsClient = true;
  }

  let proxy: ProxyServer | undefined;
  let shimServer: ShimServer | undefined;
  let shimDir: string | undefined;

  try {
    await ensureRunnerInstalled(client, runnerAsset);
    await launchRunner(client, runnerPort);
    const remoteBaseUrl = remoteRunnerBaseUrl(options.instance, runnerPort);
    await waitForRemoteStatus(remoteBaseUrl, options.instance.status.token);

    proxy = await startXCTestProxy({
      localPort: driverPort,
      remoteBaseUrl,
      token: options.instance.status.token,
    });

    shimServer = await startShimServer({ client, udid: client.deviceInfo.udid });
    shimDir = await createXcrunShim();

    const env = {
      LIMRUN_XCRUN_SHIM: '1',
      LIMRUN_IOS_UDID: client.deviceInfo.udid,
      LIMRUN_MAESTRO_SHIM_URL: shimServer.url,
      USE_XCODE_TEST_RUNNER: '1',
      PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
    };

    return {
      instance: options.instance,
      client,
      udid: client.deviceInfo.udid,
      maestroBin,
      maestroVersion,
      runnerAssetName,
      driverPort,
      runnerPort,
      env,
      cleanup: async () => {
        await cleanupRunner(client, runnerPort).catch(() => {});
        await proxy?.close().catch(() => {});
        await shimServer?.close().catch(() => {});
        if (shimDir) {
          fs.rmSync(shimDir, { recursive: true, force: true });
        }
        if (ownsClient) {
          client.disconnect();
        }
      },
    };
  } catch (error) {
    await proxy?.close().catch(() => {});
    await shimServer?.close().catch(() => {});
    if (shimDir) {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
    if (ownsClient) {
      client.disconnect();
    }
    throw error;
  }
}

export async function runMaestroTest(options: RunMaestroTestOptions): Promise<RunMaestroTestResult> {
  const flowPaths = [...(options.flowPaths ?? []), ...(options.flowPath ? [options.flowPath] : [])];
  if (flowPaths.length === 0) {
    throw new Error('runMaestroTest requires flowPath or flowPaths.');
  }

  const extraArgs = options.extraArgs ?? [];
  rejectUnsupportedShardArgs(extraArgs);
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const args = [
    'test',
    '--platform',
    'ios',
    '--device',
    options.prepared.udid,
    '--no-reinstall-driver',
    ...(options.outputDir ? ['--test-output-dir', options.outputDir] : []),
    ...extraArgs,
    ...flowPaths,
  ];

  const child = spawn(options.prepared.maestroBin, args, {
    cwd,
    env: {
      ...process.env,
      ...options.prepared.env,
      ...options.env,
    },
    stdio: 'inherit',
  });

  return await waitForProcess(child, options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS);
}

export async function runMaestroOnLimrun(options: RunMaestroOnLimrunOptions): Promise<RunMaestroOnLimrunResult> {
  const limrun = options.limrun ?? new Limrun({ apiKey: options.apiKey });
  const maestroBin = options.maestroBin ?? DEFAULT_MAESTRO_BIN;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maestroVersion = options.maestroVersion ?? resolveMaestroVersion({ maestroBin, cwd });
  const runnerAssetName = runnerAssetNameForMaestroVersion(maestroVersion);
  await resolveRunnerAsset(limrun, runnerAssetName);

  const initialAssets: IosInstanceCreateParams.Spec.InitialAsset[] = [
    ...(options.initialAssets ?? []).map((assetName) => ({
      kind: 'App' as const,
      source: 'AssetName' as const,
      assetName,
    })),
    {
      kind: 'App',
      source: 'AssetName',
      assetName: runnerAssetName,
    },
  ];

  const instance = await limrun.iosInstances.create({
    wait: true,
    reuseIfExists: options.reuseIfExists || undefined,
    ...(options.displayName || options.labels ?
      {
        metadata: {
          ...(options.displayName ? { displayName: options.displayName } : {}),
          ...(options.labels ? { labels: options.labels } : {}),
        },
      }
    : {}),
    spec: {
      initialAssets,
      ...(options.region ? { region: options.region } : {}),
      ...(options.model ? { model: options.model } : {}),
    },
  });

  let prepared: PreparedMaestroRun | undefined;
  let completed = false;
  try {
    prepared = await prepareMaestroRun({
      limrun,
      instance,
      maestroBin,
      maestroVersion,
      cwd,
    });
    const result = await runMaestroTest({
      prepared,
      flowPath: options.flowPath,
      flowPaths: options.flowPaths,
      outputDir: options.outputDir,
      env: options.env,
      cwd,
      timeoutMs: options.timeoutMs,
    });
    completed = true;
    return {
      ...result,
      instance,
      keptInstance: options.keepInstance === true,
    };
  } finally {
    await prepared?.cleanup().catch(() => {});
    if (options.keepInstance !== true) {
      await limrun.iosInstances.delete(instance.metadata.id).catch((error) => {
        if (completed) {
          throw error;
        }
      });
    }
  }
}

function assertInstanceReady(instance: MaestroIosInstance): void {
  if (!instance.status.apiUrl) {
    throw new Error('Limrun iOS instance is missing status.apiUrl.');
  }
  if (!instance.status.token) {
    throw new Error('Limrun iOS instance is missing status.token.');
  }
  if (!instance.status.targetHttpPortUrlPrefix) {
    throw new Error('Limrun iOS instance is missing status.targetHttpPortUrlPrefix.');
  }
}

async function resolveRunnerAsset(limrun: LimrunMaestroApi, runnerAssetName: string): Promise<MaestroRunnerAsset> {
  const appStoreAssets = await limrun.assets.list({
    includeAppStore: true,
    includeDownloadUrl: true,
    nameFilter: runnerAssetName,
  });
  const fallbackAssetName = runnerAssetName.replace(/^appstore\//, '');
  const fallbackAssets =
    appStoreAssets.length > 0 ?
      []
    : await limrun.assets.list({
        includeDownloadUrl: true,
        nameFilter: fallbackAssetName,
      });
  const assets = [...appStoreAssets, ...fallbackAssets];
  const asset =
    assets.find((candidate) => candidate.name === runnerAssetName) ??
    assets.find((candidate) => candidate.name === fallbackAssetName) ??
    assets[0];
  if (asset?.signedDownloadUrl) {
    return asset;
  }

  const bundledAssetPath = path.resolve(__dirname, '..', 'assets', fallbackAssetName);
  if (fs.existsSync(bundledAssetPath) && limrun.assets.getOrUpload) {
    return await limrun.assets.getOrUpload({
      path: bundledAssetPath,
      name: fallbackAssetName,
    });
  }

  if (!fs.existsSync(bundledAssetPath)) {
    throw new Error(
      `Missing Maestro iOS runner asset '${runnerAssetName}' and bundled fallback '${bundledAssetPath}' was not found.`,
    );
  }
  throw new Error(
    `Missing Maestro iOS runner asset '${runnerAssetName}'. The provided Limrun client does not support getOrUpload for bundled fallback '${fallbackAssetName}'.`,
  );
}

function resolveMaestroVersion({ maestroBin, cwd }: { maestroBin: string; cwd: string }): string {
  const result = spawnSync(maestroBin, ['--version'], {
    cwd,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error) {
    throw new Error(`Failed to run ${maestroBin} --version: ${result.error.message}`);
  }
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) {
    throw new Error(`Could not parse Maestro version from '${maestroBin} --version' output:\n${output.trim()}`);
  }
  return match[0];
}

async function ensureRunnerInstalled(client: LimrunMaestroClient, asset: MaestroRunnerAsset): Promise<void> {
  const apps = await client.listApps();
  if (apps.some((app) => app.bundleId === RUNNER_BUNDLE_ID)) {
    return;
  }
  await client.installApp(asset.signedDownloadUrl!);
}

async function launchRunner(client: LimrunMaestroClient, runnerPort: number): Promise<void> {
  await waitForSuccessfulSimctl(client, ['spawn', 'booted', 'launchctl', 'setenv', 'PORT', String(runnerPort)]);
  await waitForSuccessfulSimctl(client, ['launch', '--terminate-running-process', 'booted', RUNNER_BUNDLE_ID]);
}

async function cleanupRunner(client: LimrunMaestroClient, runnerPort: number): Promise<void> {
  await client.simctl(['terminate', 'booted', RUNNER_BUNDLE_ID]).wait().catch(() => {});
  await client.simctl(['spawn', 'booted', 'launchctl', 'unsetenv', 'PORT']).wait().catch(() => {});
  // Keep USE_IP intact. It is owned by the Limrun simulator lifecycle.
  void runnerPort;
}

async function waitForSuccessfulSimctl(client: LimrunMaestroClient, args: string[]): Promise<SimctlResult> {
  const result = await client.simctl(args).wait();
  if (result.code !== 0) {
    throw new Error(`simctl ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  return result;
}

function remoteRunnerBaseUrl(instance: MaestroIosInstance, runnerPort: number): string {
  const prefix = instance.status.targetHttpPortUrlPrefix;
  if (!prefix) {
    throw new Error('Limrun iOS instance is missing status.targetHttpPortUrlPrefix.');
  }
  return `${prefix.replace(/\/+$/, '')}${runnerPort}`;
}

async function waitForRemoteStatus(remoteBaseUrl: string, token: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const status = await requestText(`${remoteBaseUrl.replace(/\/+$/, '')}/status`, {
        Authorization: `Bearer ${token}`,
      });
      if (status.response.statusCode && status.response.statusCode >= 200 && status.response.statusCode < 300) {
        return;
      }
      lastError = `HTTP ${status.response.statusCode}: ${status.body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Maestro XCTest runner did not become reachable at ${remoteBaseUrl}/status: ${lastError}`);
}

async function startXCTestProxy({
  localPort,
  remoteBaseUrl,
  token,
}: {
  localPort: number;
  remoteBaseUrl: string;
  token: string;
}): Promise<ProxyServer> {
  const base = remoteBaseUrl.replace(/\/+$/, '');
  const server = http.createServer((req, res) => {
    const pathAndQuery = req.url || '/';
    const upstreamUrl = new URL(`${base}${pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`}`);
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    const headers = {
      ...req.headers,
      host: upstreamUrl.host,
      authorization: `Bearer ${token}`,
    };

    const upstream = transport.request(
      upstreamUrl,
      {
        method: req.method,
        headers,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );

    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(error.message);
    });
    req.pipe(upstream);
  });

  await listen(server, localPort);
  return {
    port: localPort,
    close: () => closeServer(server),
  };
}

async function startShimServer({ client, udid }: { client: LimrunMaestroClient; udid: string }): Promise<ShimServer> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/xcrun') {
      sendJson(res, 404, { code: 127, stdout: '', stderr: 'not found' });
      return;
    }
    try {
      const body = (await readJson(req)) as { args?: string[] };
      const args = body.args ?? [];
      const result = await handleShimmedXcrun(client, udid, args);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 200, {
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start Maestro xcrun shim server.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/xcrun`,
    close: () => closeServer(server),
  };
}

async function handleShimmedXcrun(client: LimrunMaestroClient, udid: string, args: string[]): Promise<SimctlResult> {
  if (args[0] !== 'simctl') {
    return { code: 127, stdout: '', stderr: `unsupported xcrun command: ${args.join(' ')}` };
  }

  const simctlArgs = args.slice(1);
  const command = simctlArgs[0];
  const target = simctlTarget(command, simctlArgs);

  if (command === 'list') {
    if (!simctlArgs.includes('-j')) {
      return { code: 64, stdout: '', stderr: 'limrun maestro shim only supports `xcrun simctl list -j`.' };
    }
    return {
      code: 0,
      stdout: `${JSON.stringify(toSimctlList(client.deviceInfo.udid))}\n`,
      stderr: '',
    };
  }

  if (!isLimrunTarget(target, udid)) {
    return { code: 64, stdout: '', stderr: `unsupported non-Limrun simctl target '${target ?? ''}'.` };
  }

  if (command === 'listapps') {
    const apps = await client.listApps();
    return {
      code: 0,
      stdout: `${JSON.stringify(toSimctlListApps(apps))}\n`,
      stderr: '',
    };
  }

  if (command === 'install') {
    const appPath = simctlArgs[2];
    if (!appPath) {
      return { code: 64, stdout: '', stderr: 'simctl install requires a local .app path.' };
    }
    await client.syncApp(appPath, { install: true, watch: false });
    return { code: 0, stdout: '', stderr: '' };
  }

  if (command === 'get_app_container') {
    return {
      code: 64,
      stdout: '',
      stderr: 'limrun maestro shim does not support get_app_container because upstream Maestro expects a local filesystem path.',
    };
  }

  if (command === 'keychain') {
    return { code: 64, stdout: '', stderr: 'limrun maestro shim does not support simctl keychain in v1.' };
  }

  if (command === 'io') {
    return { code: 64, stdout: '', stderr: 'limrun maestro shim does not support simctl io recordVideo in v1.' };
  }

  if (command === 'push' || command === 'addmedia') {
    return {
      code: 64,
      stdout: '',
      stderr: `limrun maestro shim does not support path-bearing simctl ${command} in v1.`,
    };
  }

  const forwardedCommands = new Set([
    'openurl',
    'launch',
    'terminate',
    'uninstall',
    'privacy',
    'location',
    'status_bar',
    'spawn',
  ]);
  if (!command || !forwardedCommands.has(command)) {
    return { code: 64, stdout: '', stderr: `limrun maestro shim does not support simctl ${command ?? ''}.` };
  }

  return await client.simctl(simctlArgs).wait();
}

function isLimrunTarget(value: string | undefined, udid: string): boolean {
  return value === udid || value === 'booted';
}

function simctlTarget(command: string | undefined, simctlArgs: string[]): string | undefined {
  if (command === 'launch') {
    return simctlArgs.slice(1).find((arg) => !arg.startsWith('-'));
  }
  return simctlArgs[1];
}

function toSimctlList(udid: string): Record<string, unknown> {
  const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-18-0';
  const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro';
  return {
    devices: {
      [runtimeIdentifier]: [
        {
          availability: '(available)',
          dataPath: `/tmp/limrun-sim/${udid}/data`,
          logPath: `/tmp/limrun-sim/${udid}/logs`,
          isAvailable: true,
          name: process.env['LIMRUN_IOS_DEVICE_NAME'] || 'Limrun iPhone',
          state: 'Booted',
          udid,
          deviceTypeIdentifier,
          availabilityError: null,
        },
      ],
    },
    devicetypes: [
      {
        bundlePath: '',
        identifier: deviceTypeIdentifier,
        maxRuntimeVersion: 999999,
        maxRuntimeVersionString: null,
        minRuntimeVersion: 0,
        minRuntimeVersionString: null,
        modelIdentifier: 'iPhone17,1',
        name: 'iPhone 16 Pro',
        productFamily: 'iPhone',
      },
    ],
    pairs: {},
    runtimes: [
      {
        availability: '(available)',
        bundlePath: '',
        buildversion: '22A000',
        identifier: runtimeIdentifier,
        isInternal: false,
        isAvailable: true,
        name: process.env['LIMRUN_IOS_RUNTIME_NAME'] || 'iOS 18.0',
        platform: 'iOS',
        runtimeRoot: '',
        supportedDeviceTypes: [],
        version: '18.0',
      },
    ],
  };
}

function toSimctlListApps(apps: InstalledApp[]): Record<string, { CFBundleIdentifier: string; CFBundleName?: string }> {
  return Object.fromEntries(
    apps.map((app) => [
      app.bundleId,
      {
        CFBundleIdentifier: app.bundleId,
        ...(app.name ? { CFBundleName: app.name } : {}),
      },
    ]),
  );
}

async function createXcrunShim(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-maestro-shim-'));
  const shimPath = path.join(dir, 'xcrun');
  fs.writeFileSync(shimPath, xcrunShimSource(), 'utf8');
  fs.chmodSync(shimPath, 0o755);
  return dir;
}

function xcrunShimSource(): string {
  return `#!/usr/bin/env node
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const realXcrun = process.env.LIMRUN_REAL_XCRUN || '/usr/bin/xcrun';

function delegate() {
  const result = spawnSync(realXcrun, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(String(result.error.message || result.error) + '\\n');
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}

function fail(message) {
  process.stderr.write('limrun maestro xcrun shim: ' + message + '\\n');
  process.exit(64);
}

if (process.env.LIMRUN_XCRUN_SHIM !== '1' || args[0] !== 'simctl') {
  delegate();
}

const shimUrl = process.env.LIMRUN_MAESTRO_SHIM_URL;
const udid = process.env.LIMRUN_IOS_UDID;
if (!shimUrl || !udid) {
  fail('LIMRUN_MAESTRO_SHIM_URL and LIMRUN_IOS_UDID are required.');
}

const simctlArgs = args.slice(1);
const command = simctlArgs[0];
function simctlTarget(command, simctlArgs) {
  if (command === 'launch') {
    return simctlArgs.slice(1).find((arg) => !arg.startsWith('-'));
  }
  return simctlArgs[1];
}
const target = simctlTarget(command, simctlArgs);
function isLimrunTarget(value) {
  return value === udid || value === 'booted';
}

if (command !== 'list' && !isLimrunTarget(target)) {
  delegate();
}

const parsed = new URL(shimUrl);
const body = JSON.stringify({ args });
const req = http.request(parsed, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  },
}, (res) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      process.stderr.write('limrun maestro xcrun shim: invalid shim response\\n');
      process.exit(1);
    }
    if (payload.stdout) process.stdout.write(payload.stdout);
    if (payload.stderr) process.stderr.write(payload.stderr);
    process.exit(typeof payload.code === 'number' ? payload.code : 1);
  });
});
req.on('error', (error) => {
  process.stderr.write('limrun maestro xcrun shim: ' + error.message + '\\n');
  process.exit(1);
});
req.end(body);
`;
}

function rejectUnsupportedShardArgs(args: string[]): void {
  const shardFlags = new Set(['-s', '--shards', '--shard-split', '--shard-all']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (shardFlags.has(arg) || [...shardFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      throw new Error(`@limrun/maestro v1 does not support Maestro sharding (${arg}).`);
    }
  }
}

function assertTcpPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Local Maestro driver port ${port} is already in use.`));
      } else {
        reject(error);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve());
    });
  });
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function requestText(
  url: string,
  headers: Record<string, string>,
): Promise<{ response: IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, { method: 'GET', headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          response,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function waitForProcess(child: ChildProcess, timeoutMs: number): Promise<RunMaestroTestResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Maestro did not finish within ${timeoutMs}ms.`));
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
