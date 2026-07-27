// Builds one device-bound IPA, uploads it as a private Limrun asset, and
// tracks the detached build through its authenticated build-finish webhook.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSecret, listSecrets, type StoredSecret } from './secret-store.js';

export type InstallMethod = 'webusb' | 'qr';

export type InstallRequest = {
  projectPath: string;
  method: InstallMethod;
  teamId: string;
  bundleId: string;
  deviceUDID: string;
  scheme?: string;
};

type DeviceCredentials = {
  certificate: StoredSecret;
  profile: StoredSecret;
};

function normalizeUDID(value?: string) {
  return (value ?? '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function isUnexpired(expirationDate?: string) {
  if (!expirationDate) return true;
  const expiresAt = Date.parse(expirationDate);
  return Number.isNaN(expiresAt) || expiresAt > Date.now();
}

async function resolveDeviceCredentials(request: InstallRequest): Promise<DeviceCredentials> {
  const certificateKind = request.method === 'webusb' ? 'DEVELOPMENT' : 'DISTRIBUTION';
  const profileLabel = request.method === 'webusb' ? 'development' : 'ad-hoc';
  const certificate = await getSecret('appleCertificate', `${request.teamId}/${certificateKind}`);
  if (!certificate || !isUnexpired(certificate.data.expirationDate)) {
    throw new Error(`No valid ${profileLabel} signing certificate is stored. Prepare the selected iPhone first.`);
  }

  const normalizedUDID = normalizeUDID(request.deviceUDID);
  const profiles = (await listSecrets())
    .filter(
      (secret) =>
        secret.type === 'appleProvisioningProfile' &&
        secret.data.teamID === request.teamId &&
        (secret.data.bundleIDs ?? '')
          .split(',')
          .map((value) => value.trim())
          .includes(request.bundleId) &&
        (secret.data.deviceIDs ?? '').split(',').some((value) => normalizeUDID(value) === normalizedUDID) &&
        !!certificate.data.serialNumber &&
        (secret.data.certificateSerialNumbers ?? '')
          .split(',')
          .map((value) => value.trim())
          .includes(certificate.data.serialNumber) &&
        isUnexpired(secret.data.expirationDate),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const profile = profiles[0];
  if (!profile) {
    throw new Error(`No valid ${profileLabel} profile for ${request.bundleId} covers ${request.deviceUDID}.`);
  }
  return { certificate, profile };
}

const APP_JSON_SEARCH_DEPTH = 4;

async function findExpoAppConfigs(root: string, depth = APP_JSON_SEARCH_DEPTH): Promise<string[]> {
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
        // Ignore unrelated or malformed app.json files.
      }
    } else if (entry.isDirectory() && depth > 0) {
      found.push(...(await findExpoAppConfigs(entryPath, depth - 1)));
    }
  }
  return found;
}

async function ensureExpoBundleIdentifier(projectPath: string, bundleId: string): Promise<string[]> {
  const configs = await findExpoAppConfigs(projectPath);
  if (configs.length === 0) return [];
  if (configs.length > 1) {
    return [`Warning: found multiple Expo app.json files; set expo.ios.bundleIdentifier to ${bundleId} manually.`];
  }
  const appJsonPath = configs[0]!;
  const config = JSON.parse(await readFile(appJsonPath, 'utf8')) as {
    expo: { ios?: { bundleIdentifier?: string } };
  };
  const existing = config.expo.ios?.bundleIdentifier;
  if (existing) {
    return existing === bundleId ?
        []
      : [`Warning: ${appJsonPath} declares ${existing}, but this install build targets ${bundleId}.`];
  }
  config.expo.ios = { ...config.expo.ios, bundleIdentifier: bundleId };
  await writeFile(appJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return [`Set expo.ios.bundleIdentifier in ${appJsonPath} to ${bundleId}.`];
}

export type InstallStatus = {
  id: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  method: InstallMethod;
  deviceUDID: string;
  assetName: string;
  webhook?: unknown;
  webhookReceivedAt?: string;
  error?: string;
};

type InstallEntry = {
  status: InstallStatus;
  token: string;
};

const installs = new Map<string, InstallEntry>();
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function failInstall(id: string, message: string) {
  const entry = installs.get(id);
  if (!entry || entry.status.state !== 'running') return;
  entry.status.state = 'failed';
  entry.status.error = message;
}

export function receiveInstallWebhook(id: string, token: string | undefined, payload: unknown): boolean {
  const entry = installs.get(id);
  if (!entry) return false;
  const expected = Buffer.from(entry.token);
  const received = Buffer.from(token ?? '');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  entry.status.webhook = payload;
  entry.status.webhookReceivedAt = new Date().toISOString();
  const status = (payload as { status?: string } | null)?.status;
  entry.status.state = status === 'SUCCEEDED' ? 'succeeded' : 'failed';
  if (entry.status.state === 'failed') {
    entry.status.error =
      (payload as { error?: string } | null)?.error ?? `Build finished with status ${status ?? 'unknown'}.`;
  }
  return true;
}

export function getInstallStatus(id: string): InstallStatus | undefined {
  return installs.get(id)?.status;
}

export async function startInstall(request: InstallRequest, publicUrl: string): Promise<string> {
  const { certificate, profile } = await resolveDeviceCredentials(request);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'device-install-'));
  const certificatePath = path.join(workDir, 'certificate.p12');
  const profilePath = path.join(workDir, 'profile.mobileprovision');
  await writeFile(certificatePath, Buffer.from(certificate.data.certificateP12Base64, 'base64'), {
    mode: 0o600,
  });
  await writeFile(profilePath, Buffer.from(profile.data.provisioningProfileBase64, 'base64'), {
    mode: 0o600,
  });

  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const assetName = `device-install-${request.method}-${request.bundleId}-${id}.ipa`;
  installs.set(id, {
    status: {
      id,
      state: 'running',
      startedAt: new Date().toISOString(),
      method: request.method,
      deviceUDID: request.deviceUDID,
      assetName,
    },
    token,
  });
  setTimeout(() => failInstall(id, 'No build-finish webhook arrived within two hours.'), INSTALL_TIMEOUT_MS).unref();

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
    '--upload',
    assetName,
    '--webhook-url',
    `${publicUrl}/webhook/${id}`,
    '--webhook-header',
    `X-Install-Token=${token}`,
    '--webhook-header',
    'Bypass-Tunnel-Reminder=true',
    '--inactivity-timeout',
    '3s',
    '--detach',
  ];
  if (request.scheme) args.push('--scheme', request.scheme);

  const log = (line: string) => console.log(`[install ${id}] ${line}`);
  log(`Building ${request.bundleId} for ${request.method} installation...`);
  for (const line of await ensureExpoBundleIdentifier(request.projectPath, request.bundleId)) log(line);
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
    failInstall(id, `Failed to run lim: ${error.message}. Is it installed and on PATH?`);
    void rm(workDir, { recursive: true, force: true });
  });
  child.on('close', (code) => {
    void rm(workDir, { recursive: true, force: true });
    if (code !== 0) failInstall(id, `lim exited with code ${code ?? 1}. See the backend logs.`);
  });
  return id;
}
