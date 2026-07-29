// Runs one Play Store publish with the same headless lifecycle as iOS:
// materialize the upload key, submit `lim gradle build --detach` with a
// completion webhook, and let the frontend poll the callback state.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginPublish, findExpoAppConfigs, spawnDetachedLim } from './publish.js';
import { getSecret } from './secret-store.js';

export type AndroidPublishRequest = {
  projectPath: string;
  packageName: string;
  /** Google OAuth access token with the androidpublisher scope. */
  googleAccessToken: string;
  /** Play track ID; the server defaults to internal. */
  track?: string;
  /** Store directory the upload keystore lives in; backend default when absent. */
  secretsDir?: string;
  /**
   * Public URL limbuild POSTs the build-finish webhook to, verbatim. It
   * comes from the UI with each publish and must forward to this backend's
   * webhook receiver for the result to be observed.
   */
  webhookUrl: string;
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

export async function startAndroidPublish(request: AndroidPublishRequest): Promise<string> {
  // `<package>/UPLOAD` is the secret name convention for a package's Play
  // upload keystore; the frontend stores it under the same name.
  const signingSecret = await getSecret(
    ANDROID_SIGNING_KEY_SECRET_TYPE,
    `${request.packageName}/UPLOAD`,
    request.secretsDir,
  );
  if (!signingSecret) {
    throw new Error(
      `No upload keystore stored for ${request.packageName}. Prepare one in the Connect phase first.`,
    );
  }
  const { keystoreBase64, keystorePassword, keyAlias, keyPassword } = signingSecret.data;
  if (!keystoreBase64 || !keystorePassword || !keyAlias || !keyPassword) {
    throw new Error(
      `The stored ${request.packageName} keystore secret is missing one of keystoreBase64, keystorePassword, keyAlias, keyPassword.`,
    );
  }

  const expoConfigs = await findExpoAppConfigs(request.projectPath);
  const projectUpdates = await ensureExpoAndroidPackage(expoConfigs, request.packageName);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'publish-to-stores-android-'));
  const keystorePath = path.join(workDir, 'upload.p12');
  await writeFile(keystorePath, Buffer.from(keystoreBase64, 'base64'), { mode: 0o600 });

  const { id, token } = beginPublish();
  const args = [
    'gradle',
    'build',
    request.projectPath,
    '--keystore',
    keystorePath,
    '--key-alias',
    keyAlias,
    '--upload-to-playstore',
    '--playstore-package',
    request.packageName,
    '--playstore-track',
    request.track ?? 'internal',
    '--auto-version-code',
    '--webhook-url',
    request.webhookUrl,
    '--webhook-header',
    `X-Publish-Token=${token}`,
    '--inactivity-timeout',
    '3s',
    '--detach',
    // The detach summary (instance, console link, webhook) arrives as one
    // JSON object on stdout instead of prose, so it is machine-readable here.
    '--json',
  ];

  const log = (line: string) => console.log(`[publish ${id}] ${line}`);
  log(`Publishing ${request.packageName} to the Play ${request.track ?? 'internal'} track...`);
  for (const line of projectUpdates) log(line);
  log(`$ lim ${args.join(' ')}`);
  spawnDetachedLim({
    id,
    args,
    workDir,
    // The passwords and Play token travel as environment variables so they
    // never appear in the process list.
    env: {
      ...process.env,
      LIM_KEYSTORE_PASSWORD: keystorePassword,
      LIM_KEY_PASSWORD: keyPassword,
      LIM_PLAYSTORE_ACCESS_TOKEN: request.googleAccessToken,
    },
    log,
  });
  return id;
}
