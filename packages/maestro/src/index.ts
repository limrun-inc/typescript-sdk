import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { Ios, Limrun } from '@limrun/api';
import type { IosInstanceCreateParams } from '@limrun/api/resources/ios-instances';

import { resolveMaestroVersion, resolveRunnerAsset, runnerAssetNameForMaestroVersion } from './runner-assets';
import type {
  LimrunMaestroApi,
  LimrunMaestroClient,
  MaestroIosInstance,
  PreparedMaestroRun,
  PrepareMaestroRunOptions,
  ProxyServer,
  RunMaestroOnLimrunOptions,
  RunMaestroOnLimrunResult,
  RunMaestroTestOptions,
  RunMaestroTestResult,
  ShimServer,
} from './types';
import { createXcrunShim, startShimServer } from './xcrun-shim';
import {
  assertInstanceReady,
  cleanupRunner,
  ensureRunnerInstalled,
  launchRunner,
  remoteRunnerBaseUrl,
  startXCTestProxy,
  waitForRemoteStatus,
} from './xctest';

const DEFAULT_MAESTRO_BIN = 'maestro';
const DEFAULT_DRIVER_PORT = 7001;
const DEFAULT_RUNNER_PORT = 22087;
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60_000;

type InstanceClientLease = {
  client: LimrunMaestroClient;
  ownsClient: boolean;
};

export { runnerAssetNameForMaestroVersion };
export { createXcrunShim, startShimServer } from './xcrun-shim';
export type {
  LimrunMaestroApi,
  MaestroIosInstance,
  MaestroRunnerAsset,
  PreparedMaestroRun,
  PrepareMaestroRunOptions,
  RunMaestroOnLimrunOptions,
  RunMaestroOnLimrunResult,
  RunMaestroTestOptions,
  RunMaestroTestResult,
} from './types';

export async function prepareMaestroRun(options: PrepareMaestroRunOptions): Promise<PreparedMaestroRun> {
  const maestroBin = options.maestroBin ?? DEFAULT_MAESTRO_BIN;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const maestroVersion = options.maestroVersion ?? resolveMaestroVersion({ maestroBin, cwd });
  const runnerAssetName = runnerAssetNameForMaestroVersion(maestroVersion);
  const driverPort = options.driverPort ?? DEFAULT_DRIVER_PORT;
  const runnerPort = options.runnerPort ?? DEFAULT_RUNNER_PORT;

  assertInstanceReady(options.instance);
  await assertTcpPortAvailable(driverPort);

  const runnerAsset = await resolveRunnerAsset(options.limrun, runnerAssetName);
  const { client, ownsClient } = await getInstanceClient(options);

  let proxy: ProxyServer | undefined;
  let shimServer: ShimServer | undefined;
  let shimDir: string | undefined;
  let runnerLaunched = false;

  try {
    // Maestro is started in "connect to an existing XCTest runner" mode. These
    // steps are the Limrun-owned replacement for Maestro's local xcodebuild/simctl
    // runner lifecycle.
    await ensureRunnerInstalled(client, runnerAsset);
    await launchRunner(client, runnerPort);
    runnerLaunched = true;
    await waitForRemoteStatus(remoteRunnerBaseUrl(options.instance, runnerPort), options.instance.status.token);

    proxy = await startXCTestProxy({
      localPort: driverPort,
      remoteBaseUrl: remoteRunnerBaseUrl(options.instance, runnerPort),
      token: options.instance.status.token,
    });

    // The shim is process-scoped: only the spawned Maestro process sees the
    // temporary xcrun executable at the front of PATH.
    shimServer = await startShimServer({ client, udid: client.deviceInfo.udid });
    shimDir = await createXcrunShim();

    return {
      instance: options.instance,
      client,
      udid: client.deviceInfo.udid,
      maestroBin,
      maestroVersion,
      runnerAssetName,
      driverPort,
      runnerPort,
      env: maestroChildEnv({ shimDir, shimServer, udid: client.deviceInfo.udid }),
      cleanup: async () => {
        await cleanupPreparedRun({ client, ownsClient, proxy, runnerLaunched, shimDir, shimServer });
      },
    };
  } catch (error) {
    await cleanupPreparedRun({ client, ownsClient, proxy, runnerLaunched, shimDir, shimServer });
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

  const child = spawn(options.prepared.maestroBin, maestroTestArgs(options, flowPaths, extraArgs), {
    cwd: path.resolve(options.cwd ?? process.cwd()),
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
  const runnerAsset = await resolveRunnerAsset(limrun, runnerAssetName);

  const instance = await createLimrunInstance(limrun, options, runnerAsset.name);

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
      await deleteInstance(limrun, instance, { rethrow: completed });
    }
  }
}

async function getInstanceClient(options: PrepareMaestroRunOptions): Promise<InstanceClientLease> {
  if (options.client) {
    return { client: options.client, ownsClient: false };
  }
  return {
    client: await Ios.createInstanceClient({
      apiUrl: options.instance.status.apiUrl!,
      token: options.instance.status.token,
      logLevel: 'none',
    }),
    ownsClient: true,
  };
}

function maestroChildEnv({
  shimDir,
  shimServer,
  udid,
}: {
  shimDir: string;
  shimServer: ShimServer;
  udid: string;
}): Record<string, string> {
  return {
    LIMRUN_XCRUN_SHIM: '1',
    LIMRUN_IOS_UDID: udid,
    LIMRUN_XCRUN_SHIM_URL: shimServer.url,
    USE_XCODE_TEST_RUNNER: '1',
    PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
  };
}

async function cleanupPreparedRun({
  client,
  ownsClient,
  proxy,
  runnerLaunched,
  shimDir,
  shimServer,
}: {
  client: LimrunMaestroClient;
  ownsClient: boolean;
  proxy?: ProxyServer;
  runnerLaunched: boolean;
  shimDir?: string;
  shimServer?: ShimServer;
}): Promise<void> {
  if (runnerLaunched) {
    await cleanupRunner(client).catch(() => {});
  }
  await proxy?.close().catch(() => {});
  await shimServer?.close().catch(() => {});
  if (shimDir) {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
  if (ownsClient) {
    client.disconnect();
  }
}

function maestroTestArgs(
  options: RunMaestroTestOptions,
  flowPaths: string[],
  extraArgs: string[],
): string[] {
  return [
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
}

async function createLimrunInstance(
  limrun: LimrunMaestroApi,
  options: RunMaestroOnLimrunOptions,
  runnerAssetName: string,
): Promise<MaestroIosInstance> {
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

  return await limrun.iosInstances.create({
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
}

async function deleteInstance(
  limrun: LimrunMaestroApi,
  instance: MaestroIosInstance,
  { rethrow }: { rethrow: boolean },
): Promise<void> {
  await limrun.iosInstances.delete(instance.metadata.id).catch((error) => {
    if (rethrow) {
      throw error;
    }
  });
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
