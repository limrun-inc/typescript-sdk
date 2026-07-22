// Runs one Play Store publish: resolves the escrowed upload keystore,
// provisions a gradle instance, syncs the project, and runs a signed
// bundleRelease whose playstore stage publishes the AAB to the requested
// track, streaming output as Server-Sent Events. The Google access token
// is browser-minted, rides this one request, and is never stored; the
// Limrun API key never leaves this backend. The AAB is also uploaded as a
// named asset so a failed publish leaves the artifact for a retry.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { Limrun, type GradlePlaystoreConfig } from '@limrun/api';
import { findExpoAppConfigs } from './publish.js';
import { getSecret } from './secret-store.js';

export type AndroidPublishRequest = {
  projectPath: string;
  packageName: string;
  /** Google OAuth access token with the androidpublisher scope. */
  googleAccessToken: string;
  /** Play track ID; the server defaults to internal. */
  track?: string;
};

/**
 * Detects the Android application ID from a project, so the wizard can
 * prefill it from the project path alone. Same heuristics (and the same
 * comment-skipping) as the lim CLI's signing key resolution: Expo app
 * config first, then app/build.gradle(.kts) under the conventional roots.
 */
export async function detectAndroidPackage(projectPath: string): Promise<string | undefined> {
  for (const configPath of await findExpoAppConfigs(projectPath)) {
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        expo?: { android?: { package?: string } };
      };
      if (config.expo?.android?.package) return config.expo.android.package;
    } catch {
      // Unreadable config; keep probing.
    }
  }
  for (const root of ['.', 'android']) {
    for (const candidate of ['app/build.gradle', 'app/build.gradle.kts']) {
      let content: string;
      try {
        content = await readFile(path.join(projectPath, root, candidate), 'utf8');
      } catch {
        continue;
      }
      // Skip line comments so a commented-out previous ID cannot shadow
      // the live one. First live match wins.
      for (const line of content.split('\n')) {
        const code = line.split('//', 1)[0]!;
        const match = code.match(/applicationId\s*=?\s*["']([A-Za-z0-9_.]+)["']/);
        if (match) return match[1];
      }
    }
  }
  return undefined;
}

/**
 * The Android twin of the iOS flow's ensureExpoBundleIdentifier: prebuild
 * derives the applicationId from expo.android.package, and without it Expo
 * falls back to a placeholder. Only a missing field is filled in; an
 * existing different value is reported, not touched. Takes the already
 * discovered Expo configs so the project tree is walked once per publish.
 * Returns log lines.
 */
export async function ensureExpoAndroidPackage(configs: string[], packageName: string): Promise<string[]> {
  if (configs.length === 0) {
    return []; // Not an Expo project; the Gradle project owns its ID.
  }
  if (configs.length > 1) {
    return [
      `Warning: found more than one Expo app.json (${configs.join(', ')}); ` +
        'not touching any of them. Set expo.android.package yourself in the one being published.',
    ];
  }
  const appJsonPath = configs[0]!;
  const config = JSON.parse(await readFile(appJsonPath, 'utf8')) as {
    expo: { android?: { package?: string } };
  };
  const existing = config.expo.android?.package;
  if (existing) {
    if (existing !== packageName) {
      return [
        `Warning: ${appJsonPath} declares expo.android.package ${existing}, but this publish ` +
          `targets ${packageName}. Google Play matches on the AAB's applicationId, so the publish will fail ` +
          'unless they agree.',
      ];
    }
    return [];
  }
  config.expo.android = { ...config.expo.android, package: packageName };
  await writeFile(appJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return [`${appJsonPath} had no expo.android.package; set it to ${packageName}.`];
}

export const ANDROID_SIGNING_KEY_SECRET_TYPE = 'androidSigningKey';

/** Secret name convention for a package's Play upload keystore. */
export function androidSigningKeySecretName(packageName: string) {
  return `${packageName}/UPLOAD`;
}

/**
 * The gradle build outlives the default 5m inactivity window on large
 * projects (dependency install + prebuild + bundleRelease); the exec
 * stream counts as activity, so this is just headroom for the sync gap.
 */
const INSTANCE_INACTIVITY_TIMEOUT = '15m';

export async function streamAndroidPublish(
  request: AndroidPublishRequest,
  apiKey: string,
  res: Response,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: string) => {
    res.write(`event: ${event}\n`);
    for (const line of data.split('\n')) {
      res.write(`data: ${line}\n`);
    }
    res.write('\n');
  };

  const limrun = new Limrun({ apiKey });
  let instanceId: string | undefined;
  try {
    const signingSecret = await getSecret(
      ANDROID_SIGNING_KEY_SECRET_TYPE,
      androidSigningKeySecretName(request.packageName),
    );
    if (!signingSecret) {
      throw new Error(
        `No upload keystore stored for ${request.packageName}. Import one in the Connect phase first.`,
      );
    }
    const { keystoreBase64, keystorePassword, keyAlias, keyPassword } = signingSecret.data;
    if (!keystoreBase64 || !keystorePassword || !keyAlias || !keyPassword) {
      throw new Error(
        `The stored ${request.packageName} keystore secret is missing one of keystoreBase64, keystorePassword, keyAlias, keyPassword.`,
      );
    }

    send('stdout', `Publishing ${request.packageName} to the Play ${request.track ?? 'internal'} track...`);
    const expoConfigs = await findExpoAppConfigs(request.projectPath);
    for (const line of await ensureExpoAndroidPackage(expoConfigs, request.packageName)) {
      send('stdout', line);
    }
    send('stdout', 'Creating a gradle instance...');
    const instance = await limrun.gradleInstances.create({
      wait: true,
      metadata: { displayName: `publish-to-stores ${request.packageName}` },
      spec: { inactivityTimeout: INSTANCE_INACTIVITY_TIMEOUT },
    });
    instanceId = instance.metadata.id;
    send('stdout', `Instance ${instanceId} ready (${instance.spec.region}).`);

    const gradle = await limrun.gradleInstances.createClient({ instance });
    send('stdout', `Syncing ${request.projectPath}...`);
    const sync = await gradle.sync(request.projectPath);
    send('stdout', `Sync complete${sync.bytesSent !== undefined ? ` (${sync.bytesSent} bytes sent)` : ''}.`);

    // The platform owns the versionCode: the server resolves the next
    // free one from Google Play and stamps it before the build, into the
    // Expo config for Expo projects or the module build script's literal
    // versionCode for native Gradle projects.
    const playstore: GradlePlaystoreConfig = {
      accessToken: request.googleAccessToken,
      packageName: request.packageName,
      autoIncrementVersionCode: true,
      ...(request.track && { track: request.track }),
    };
    const proc = gradle.gradlebuild({
      signing: { keystoreBase64, keystorePassword, keyAlias, keyPassword },
      playstore,
      upload: { assetName: `${request.packageName}-${Date.now()}.aab` },
    });
    proc.stdout.on('data', (line: string) => send('stdout', line));
    proc.stderr.on('data', (line: string) => send('stderr', line));
    // A closed browser tab must not leave a build running unattended.
    res.on('close', () => {
      void proc.kill().catch(() => undefined);
    });

    const result = await proc;
    if (result.playstore?.state === 'accepted') {
      const versionCode =
        result.playstore.versionCode !== undefined ? ` as versionCode ${result.playstore.versionCode}` : '';
      send('stdout', `Published to the Play ${result.playstore.track ?? 'internal'} track${versionCode}.`);
    } else if (result.playstore?.state === 'failed') {
      const code = result.playstore.code ? ` [${result.playstore.code}]` : '';
      send('stderr', `Play publish failed${code}: ${result.playstore.message ?? 'see the log above'}.`);
    } else if (result.exitCode === 0) {
      // The playstore SSE event doubles as the capability handshake: a
      // successful build without one means the server ignored the request.
      send(
        'stderr',
        'The server reported no Play Store publish state; the AAB was built but likely not published.',
      );
    }
    send('exit', String(result.exitCode));
    res.end();
  } catch (error) {
    send('error', error instanceof Error ? error.message : 'Publish failed');
    res.end();
  } finally {
    if (instanceId) {
      // Builds are one-shot in this example; the instance has no further use.
      void limrun.gradleInstances.delete(instanceId).catch(() => undefined);
    }
  }
}
