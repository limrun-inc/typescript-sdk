// Runs one publish: materializes the stored signing secrets into temp files,
// spawns `lim xcode build ... --upload-to-testflight --auto-build-number`
// armed with a build-finish webhook, and tracks the publish until that
// webhook arrives. Both the TestFlight and App Store methods run the same
// upload — an App Store release is the same App Store Connect upload
// followed by submitting the processed build to review in the App Store
// Connect UI.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSecret, listSecrets, type StoredSecret } from './secret-store.js';

export type PublishRequest = {
  projectPath: string;
  method: 'testflight' | 'appstore';
  teamId: string;
  bundleId: string;
  scheme?: string;
};

type PublishCredentials = {
  certificate: StoredSecret;
  profile: StoredSecret;
  apiKey: StoredSecret;
};

/**
 * Resolves the three secrets a store upload needs. The distribution
 * certificate and App Store Connect API key live under conventional names;
 * the App Store profile is found by its references: same team, binds the
 * bundle ID, and binds no devices (only App Store profiles are device-free).
 */
export async function resolvePublishCredentials(
  teamId: string,
  bundleId: string,
): Promise<PublishCredentials> {
  const certificate = await getSecret('appleCertificate', `${teamId}/DISTRIBUTION`);
  if (!certificate) {
    throw new Error(`No distribution certificate stored for team ${teamId}. Run Connect first.`);
  }
  const apiKey = await getSecret('appStoreConnectApiKey', `${teamId}/APP_STORE_CONNECT_API_KEY`);
  if (!apiKey) {
    throw new Error(`No App Store Connect API key stored for team ${teamId}. Run Connect first.`);
  }
  const profiles = (await listSecrets())
    .filter(
      (secret) =>
        secret.type === 'appleProvisioningProfile' &&
        secret.data.teamID === teamId &&
        (secret.data.bundleIDs ?? '').split(',').includes(bundleId) &&
        !secret.data.deviceIDs,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const profile = profiles[0];
  if (!profile) {
    throw new Error(`No App Store provisioning profile stored for ${bundleId}. Run Connect first.`);
  }
  return { certificate, profile, apiKey };
}

// How deep findExpoAppConfigs descends. Monorepos nest their Expo app a few
// levels down (e.g. artifacts/mobile/app.json); anything deeper is unlikely
// to be the app being published.
const APP_JSON_SEARCH_DEPTH = 4;

/**
 * Finds Expo configs (app.json files whose JSON carries an "expo" key)
 * under the project root, so monorepo layouts work without pointing the
 * wizard at the app directory itself. node_modules and hidden directories
 * are skipped.
 */
export async function findExpoAppConfigs(root: string, depth = APP_JSON_SEARCH_DEPTH): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === 'app.json') {
      try {
        const config = JSON.parse(await readFile(entryPath, 'utf8')) as { expo?: unknown };
        if (config.expo) found.push(entryPath);
      } catch {
        // Unreadable or non-JSON app.json files are not Expo configs.
      }
    } else if (entry.isDirectory() && depth > 0) {
      found.push(...(await findExpoAppConfigs(entryPath, depth - 1)));
    }
  }
  return found;
}

/**
 * For Expo projects, makes sure app.json declares the bundle ID the user
 * chose in the wizard: prebuild writes expo.ios.bundleIdentifier into the
 * generated Xcode project, and without it Expo falls back to a placeholder
 * like com.anonymous.<slug>. The config is searched for under the project
 * root, so monorepos work. Only a missing field is filled in — an existing
 * value belongs to the project and is not touched, though a mismatch is
 * reported. Returns lines to surface in the publish log.
 */
export async function ensureExpoBundleIdentifier(projectPath: string, bundleId: string): Promise<string[]> {
  const configs = await findExpoAppConfigs(projectPath);
  if (configs.length === 0) {
    return []; // Not an Expo project; nothing to do.
  }
  if (configs.length > 1) {
    return [
      `Warning: found more than one Expo app.json (${configs.join(', ')}); ` +
        'not touching any of them. Set expo.ios.bundleIdentifier yourself in the one being published.',
    ];
  }
  const appJsonPath = configs[0]!;
  const config = JSON.parse(await readFile(appJsonPath, 'utf8')) as {
    expo: { ios?: { bundleIdentifier?: string } };
  };
  const existing = config.expo.ios?.bundleIdentifier;
  if (existing) {
    if (existing !== bundleId) {
      return [
        `Warning: ${appJsonPath} declares expo.ios.bundleIdentifier ${existing}, but this publish ` +
          `targets ${bundleId}. The provisioning profile's bundle ID wins for the upload.`,
      ];
    }
    return [];
  }
  config.expo.ios = { ...config.expo.ios, bundleIdentifier: bundleId };
  await writeFile(appJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return [`${appJsonPath} had no expo.ios.bundleIdentifier; set it to ${bundleId}.`];
}

export type PublishStatus = {
  id: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  /** The build-finish webhook payload, verbatim as limbuild POSTed it. */
  webhook?: unknown;
  webhookReceivedAt?: string;
  /** Why the publish failed before (or without) a webhook arriving. */
  error?: string;
};

type PublishEntry = {
  status: PublishStatus;
  /** Shared secret limbuild echoes back in the X-Publish-Token header. */
  token: string;
};

// In-memory publish registry — one entry per POST /publish for the life of
// the process, which is all a demo needs. A real service would persist these.
const publishes = new Map<string, PublishEntry>();

// How long after a clean CLI exit to keep waiting for the webhook. Delivery
// is near-immediate (limbuild fires it when the build reaches its terminal
// state, before the CLI's log stream ends) with bounded retries, so a miss
// past this window means the callback URL is not reachable from the internet.
const WEBHOOK_GRACE_MS = 2 * 60 * 1000;

/**
 * Marks the publish failed unless a webhook already settled it. Used for
 * every pre-webhook failure path: spawn errors, non-zero CLI exits, and the
 * post-exit grace timeout.
 */
function failPublish(id: string, message: string) {
  const entry = publishes.get(id);
  if (!entry || entry.status.state !== 'running') return;
  entry.status.state = 'failed';
  entry.status.error = message;
}

/**
 * Records the build-finish webhook for a publish. The token guards the
 * endpoint: the callback URL travels through ngrok and is guessable, so
 * limbuild proves itself with the per-publish secret it was given via
 * --webhook-header. Returns false when the token does not match.
 */
export function receivePublishWebhook(id: string, token: string | undefined, payload: unknown): boolean {
  const entry = publishes.get(id);
  if (!entry) return false;
  const expected = Buffer.from(entry.token);
  const got = Buffer.from(token ?? '');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
  entry.status.webhook = payload;
  entry.status.webhookReceivedAt = new Date().toISOString();
  const status = (payload as { status?: string } | null)?.status;
  entry.status.state = status === 'SUCCEEDED' ? 'succeeded' : 'failed';
  if (entry.status.state === 'failed') {
    const buildError = (payload as { error?: string } | null)?.error;
    entry.status.error = buildError ?? `Build finished with status ${status ?? 'unknown'}.`;
  }
  return true;
}

export function getPublishStatus(id: string): PublishStatus | undefined {
  return publishes.get(id)?.status;
}

/**
 * Materializes the stored signing secrets into temp files and spawns
 * `lim xcode build` with a build-finish webhook pointing back at this
 * backend (through the public tunnel URL). Returns the publish ID the
 * frontend polls; the outcome arrives via the webhook, not the CLI's
 * output — that output only goes to this process's console for debugging.
 */
export async function startPublish(request: PublishRequest, publicUrl: string): Promise<string> {
  const { certificate, profile, apiKey } = await resolvePublishCredentials(
    request.teamId,
    request.bundleId,
  );

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'publish-to-stores-'));
  const certificatePath = path.join(workDir, 'certificate.p12');
  const profilePath = path.join(workDir, 'profile.mobileprovision');
  const apiKeyPath = path.join(workDir, 'AuthKey.p8');
  await writeFile(certificatePath, Buffer.from(certificate.data.certificateP12Base64, 'base64'), {
    mode: 0o600,
  });
  await writeFile(profilePath, Buffer.from(profile.data.provisioningProfileBase64, 'base64'), {
    mode: 0o600,
  });
  await writeFile(apiKeyPath, Buffer.from(apiKey.data.privateKeyP8Base64, 'base64'), { mode: 0o600 });

  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  publishes.set(id, {
    status: { id, state: 'running', startedAt: new Date().toISOString() },
    token,
  });

  const args = [
    'xcode',
    'build',
    request.projectPath,
    '--sdk',
    'iphoneos',
    '--configuration',
    'Release',
    '--certificate-p12',
    certificatePath,
    '--certificate-password',
    certificate.data.certificatePassword ?? '',
    '--provisioning-profile',
    profilePath,
    '--upload-to-testflight',
    '--auto-build-number',
    '--asc-key-id',
    apiKey.data.keyId,
    '--asc-key',
    apiKeyPath,
    '--webhook-url',
    `${publicUrl}/webhook/${id}`,
    '--webhook-header',
    `X-Publish-Token=${token}`,
  ];
  if (apiKey.data.issuerId) {
    args.push('--asc-issuer-id', apiKey.data.issuerId);
  }
  if (request.scheme) {
    args.push('--scheme', request.scheme);
  }

  const log = (line: string) => console.log(`[publish ${id}] ${line}`);
  log(`Publishing ${request.bundleId} via ${request.method}...`);
  for (const line of await ensureExpoBundleIdentifier(request.projectPath, request.bundleId)) {
    log(line);
  }
  log(`$ lim ${args.join(' ')}`);

  const child = spawn('lim', args, { env: process.env });
  const forwardLines = (stream: NodeJS.ReadableStream) => {
    let buffered = '';
    stream.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) log(line);
    });
  };
  forwardLines(child.stdout);
  forwardLines(child.stderr);
  child.on('error', (error) => {
    failPublish(id, `Failed to run the lim CLI: ${error.message}. Is it installed and on PATH?`);
    void rm(workDir, { recursive: true, force: true });
  });
  child.on('close', (code) => {
    void rm(workDir, { recursive: true, force: true });
    if (code !== 0) {
      // The build never reached limbuild (bad path, sync failure, ...) or
      // failed client-side; no webhook is coming, so settle the publish here.
      failPublish(id, `lim exited with code ${code ?? 1} before the build finished. See the backend logs.`);
      return;
    }
    // A clean exit means limbuild saw the build end and has fired (or is
    // retrying) the webhook. If it never lands, the tunnel is the suspect.
    setTimeout(() => {
      failPublish(
        id,
        'The build finished but no webhook arrived. Is the tunnel URL reachable from the internet?',
      );
    }, WEBHOOK_GRACE_MS).unref();
  });

  return id;
}
