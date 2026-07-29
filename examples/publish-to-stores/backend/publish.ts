// Runs one store publish: materializes stored signing secrets into temp files,
// starts a detached `lim xcode build` with a build-finish webhook, uploads to
// App Store Connect, and tracks the build until the callback arrives.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSecret, listSecrets, type StoredSecret } from './secret-store.js';

export type PublishRequest = {
  projectPath: string;
  teamId: string;
  bundleId: string;
  scheme?: string;
  /** Store directory the signing secrets live in; backend default when absent. */
  secretsDir?: string;
  /**
   * Public URL limbuild POSTs the build-finish webhook to, verbatim. It
   * comes from the UI with each publish and must forward to this backend's
   * webhook receiver for the result to be observed.
   */
  webhookUrl: string;
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
  secretsDir?: string,
): Promise<PublishCredentials> {
  const certificate = await getSecret('appleCertificate', `${teamId}/DISTRIBUTION`, secretsDir);
  if (!certificate) {
    throw new Error(`No distribution certificate stored for team ${teamId}. Run Connect first.`);
  }
  const apiKey = await getSecret('appStoreConnectApiKey', `${teamId}/APP_STORE_CONNECT_API_KEY`, secretsDir);
  if (!apiKey) {
    throw new Error(`No App Store Connect API key stored for team ${teamId}. Run Connect first.`);
  }
  const profiles = (await listSecrets(secretsDir))
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
  /**
   * Console page of the instance the build runs on, taken from the lim
   * CLI's --json detach summary. Known as soon as the build is accepted,
   * long before the webhook arrives, so the UI can link to live progress.
   */
  consoleUrl?: string;
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

// Upper bound for a detached publish. The CLI exits as soon as limbuild
// accepts the build, so its process lifetime says nothing about build
// completion. The webhook normally arrives much sooner; this only prevents a
// permanently-running UI when the build or callback is lost.
const PUBLISH_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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

/** Allocates the authenticated callback state shared by iOS and Android publishes. */
export function beginPublish(): { id: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  publishes.set(id, {
    status: {
      id,
      state: 'running',
      startedAt: new Date().toISOString(),
    },
    token,
  });
  setTimeout(() => {
    failPublish(id, 'No build-finish webhook arrived within two hours.');
  }, PUBLISH_TIMEOUT_MS).unref();
  return { id, token };
}

/**
 * Records the build-finish webhook for the publish whose token matches.
 * limbuild POSTs to the webhook URL exactly as provided — no publish ID rides
 * the URL — so the per-publish X-Publish-Token secret is both the
 * authentication and the correlation. Returns the settled publish's ID,
 * or undefined when no publish matches.
 */
export function receivePublishWebhook(token: string | undefined, payload: unknown): string | undefined {
  const received = Buffer.from(token ?? '');
  for (const [id, entry] of publishes) {
    const expected = Buffer.from(entry.token);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) continue;
    entry.status.webhook = payload;
    entry.status.webhookReceivedAt = new Date().toISOString();
    const status = (payload as { status?: string } | null)?.status;
    entry.status.state = status === 'SUCCEEDED' ? 'succeeded' : 'failed';
    if (entry.status.state === 'failed') {
      entry.status.error = `Build finished with status ${status ?? 'unknown'}. See the persisted build log.`;
    }
    return id;
  }
  return undefined;
}

export function getPublishStatus(id: string): PublishStatus | undefined {
  return publishes.get(id)?.status;
}

/**
 * Reads the console link out of the lim CLI's detach summary. The build
 * commands run with --json, which suppresses progress logs, so on a clean
 * exit stdout is exactly the summary object.
 */
function recordPublishConsoleUrl(id: string, cliStdout: string, log: (line: string) => void) {
  const entry = publishes.get(id);
  if (!entry) return;
  try {
    const summary = JSON.parse(cliStdout) as { consoleUrl?: string };
    if (summary.consoleUrl) entry.status.consoleUrl = summary.consoleUrl;
  } catch {
    log('Could not parse the lim CLI detach summary; no console link for this publish.');
  }
}

/**
 * Spawns a detached `lim` build and wires its lifecycle to a publish: all
 * output is forwarded line by line to this process's console, a spawn error
 * or non-zero exit settles the publish as failed (the build never reached
 * limbuild, so no webhook is coming), and a clean exit records the console
 * link from the --json detach summary. The temp workDir holding the
 * materialized secrets is deleted as soon as the CLI exits.
 */
export function spawnDetachedLim(options: {
  id: string;
  args: string[];
  workDir: string;
  /** Environment for the CLI; defaults to this process's environment. */
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
}) {
  const { id, args, workDir, log } = options;
  const child = spawn('lim', args, { env: options.env ?? process.env });
  let stdoutText = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutText += chunk.toString('utf8');
  });
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
      failPublish(id, `lim exited with code ${code ?? 1} before the build finished. See the backend logs.`);
      return;
    }
    recordPublishConsoleUrl(id, stdoutText, log);
  });
}

/**
 * Materializes the stored signing secrets into temp files and spawns
 * `lim xcode build` with a build-finish webhook pointing at the URL the
 * request carries. Returns the publish ID the frontend polls; the outcome
 * arrives via the webhook, not the CLI's output — that output only goes to
 * this process's console for debugging.
 */
export async function startPublish(request: PublishRequest): Promise<string> {
  const credentials = await resolvePublishCredentials(request.teamId, request.bundleId, request.secretsDir);
  const { certificate, profile } = credentials;

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'publish-to-stores-'));
  const certificatePath = path.join(workDir, 'certificate.p12');
  const profilePath = path.join(workDir, 'profile.mobileprovision');
  await writeFile(certificatePath, Buffer.from(certificate.data.certificateP12Base64, 'base64'), {
    mode: 0o600,
  });
  await writeFile(profilePath, Buffer.from(profile.data.provisioningProfileBase64, 'base64'), {
    mode: 0o600,
  });

  const { id, token } = beginPublish();

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
  const apiKeyPath = path.join(workDir, 'AuthKey.p8');
  await writeFile(apiKeyPath, Buffer.from(credentials.apiKey.data.privateKeyP8Base64, 'base64'), {
    mode: 0o600,
  });
  args.push(
    '--upload-to-appstore',
    '--auto-build-number',
    '--asc-key-id',
    credentials.apiKey.data.keyId,
    '--asc-key',
    apiKeyPath,
  );
  if (credentials.apiKey.data.issuerId) {
    args.push('--asc-issuer-id', credentials.apiKey.data.issuerId);
  }
  if (request.scheme) {
    args.push('--scheme', request.scheme);
  }

  const log = (line: string) => console.log(`[publish ${id}] ${line}`);
  log(`Publishing ${request.bundleId} to App Store Connect...`);
  for (const line of await ensureExpoBundleIdentifier(request.projectPath, request.bundleId)) {
    log(line);
  }
  log(`$ lim ${args.join(' ')}`);
  spawnDetachedLim({ id, args, workDir, log });
  return id;
}
