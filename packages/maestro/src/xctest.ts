import http, { type IncomingMessage } from 'http';
import https from 'https';

import { startHttpProxy } from '@limrun/api/http-proxy';

import type {
  LimrunMaestroClient,
  MaestroIosInstance,
  MaestroRunnerAsset,
  ProxyServer,
  SimctlResult,
} from './types';

const RUNNER_BUNDLE_ID = 'dev.mobile.maestro-driver-iosUITests.xctrunner';

export function assertInstanceReady(instance: MaestroIosInstance): void {
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

export async function ensureRunnerInstalled(
  client: LimrunMaestroClient,
  asset: MaestroRunnerAsset,
): Promise<void> {
  const apps = await client.listApps();
  if (apps.some((app) => app.bundleId === RUNNER_BUNDLE_ID)) {
    return;
  }
  await client.installApp(asset.signedDownloadUrl!);
}

export async function launchRunner(client: LimrunMaestroClient, runnerPort: number): Promise<void> {
  // The patched runner reads PORT and USE_IP from the simulator environment.
  // USE_IP is owned by Limrun's image; we set only PORT before launching.
  await waitForSuccessfulSimctl(client, ['spawn', 'booted', 'launchctl', 'setenv', 'PORT', String(runnerPort)]);
  await waitForSuccessfulSimctl(client, ['launch', '--terminate-running-process', 'booted', RUNNER_BUNDLE_ID]);
}

export async function cleanupRunner(client: LimrunMaestroClient): Promise<void> {
  await client.simctl(['terminate', 'booted', RUNNER_BUNDLE_ID]).wait().catch(() => {});
  await client.simctl(['spawn', 'booted', 'launchctl', 'unsetenv', 'PORT']).wait().catch(() => {});
  // Keep USE_IP intact. It is owned by the Limrun simulator image lifecycle.
}

export function remoteRunnerBaseUrl(instance: MaestroIosInstance, runnerPort: number): string {
  const prefix = instance.status.targetHttpPortUrlPrefix;
  if (!prefix) {
    throw new Error('Limrun iOS instance is missing status.targetHttpPortUrlPrefix.');
  }
  return `${trimTrailingSlashes(prefix)}${runnerPort}`;
}

export async function waitForRemoteStatus(
  remoteBaseUrl: string,
  token: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const status = await requestText(`${trimTrailingSlashes(remoteBaseUrl)}/status`, {
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

export async function startXCTestProxy({
  localPort,
  remoteBaseUrl,
  token,
}: {
  localPort: number;
  remoteBaseUrl: string;
  token: string;
}): Promise<ProxyServer> {
  return await startHttpProxy({
    localPort,
    remoteBaseUrl,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
}

async function waitForSuccessfulSimctl(client: LimrunMaestroClient, args: string[]): Promise<SimctlResult> {
  const result = await client.simctl(args).wait();
  if (result.code !== 0) {
    throw new Error(`simctl ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  return result;
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

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
