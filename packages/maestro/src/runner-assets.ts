import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { LimrunMaestroApi, MaestroRunnerAsset } from './types';

export function runnerAssetNameForMaestroVersion(version: string): string {
  return `appstore/maestro-ios-runner-${version}.tar.gz`;
}

export function resolveMaestroVersion({ maestroBin, cwd }: { maestroBin: string; cwd: string }): string {
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

export async function resolveRunnerAsset(
  limrun: LimrunMaestroApi,
  runnerAssetName: string,
): Promise<MaestroRunnerAsset> {
  const fallbackAssetName = stripAppStorePrefix(runnerAssetName);

  const publicAsset = await findRunnerAsset(limrun, runnerAssetName, { includeAppStore: true });
  if (publicAsset?.signedDownloadUrl) {
    return publicAsset;
  }

  const orgAsset = await findRunnerAsset(limrun, fallbackAssetName, { includeAppStore: false });
  if (orgAsset?.signedDownloadUrl) {
    return orgAsset;
  }

  return await uploadBundledRunnerAsset(limrun, runnerAssetName, fallbackAssetName);
}

async function findRunnerAsset(
  limrun: LimrunMaestroApi,
  assetName: string,
  { includeAppStore }: { includeAppStore: boolean },
): Promise<MaestroRunnerAsset | undefined> {
  const assets = await limrun.assets.list({
    includeDownloadUrl: true,
    ...(includeAppStore ? { includeAppStore: true } : {}),
    nameFilter: assetName,
  });
  return assets.find((candidate) => candidate.name === assetName);
}

async function uploadBundledRunnerAsset(
  limrun: LimrunMaestroApi,
  runnerAssetName: string,
  fallbackAssetName: string,
): Promise<MaestroRunnerAsset> {
  const bundledAssetPath = path.resolve(__dirname, '..', 'assets', fallbackAssetName);
  if (!fs.existsSync(bundledAssetPath)) {
    throw new Error(
      `Missing Maestro iOS runner asset '${runnerAssetName}' and bundled fallback '${bundledAssetPath}' was not found.`,
    );
  }
  if (!limrun.assets.getOrUpload) {
    throw new Error(
      `Missing Maestro iOS runner asset '${runnerAssetName}'. The provided Limrun client does not support getOrUpload for bundled fallback '${fallbackAssetName}'.`,
    );
  }

  return await limrun.assets.getOrUpload({
    path: bundledAssetPath,
    name: fallbackAssetName,
  });
}

function stripAppStorePrefix(assetName: string): string {
  const prefix = 'appstore/';
  return assetName.startsWith(prefix) ? assetName.slice(prefix.length) : assetName;
}
