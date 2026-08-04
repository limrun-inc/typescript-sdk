import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POSTHOG_HOST, DEFAULT_POSTHOG_PROJECT_KEY } from './telemetry-config';

const CLI_VERSION = require('../../package.json').version as string;
const TELEMETRY_SCHEMA_VERSION = 1;
const DEFAULT_SEND_TIMEOUT_MS = 750;
const INSTALLATION_FILE_VERSION = 1;

export type TelemetryEvent =
  | 'skills_install_started'
  | 'skills_install_succeeded'
  | 'skills_install_failed'
  | 'cli_auth_started'
  | 'cli_auth_failed'
  | 'instance_create_requested'
  | 'build_requested';

export type TelemetryProperty = string | number | boolean;
export type TelemetryProperties = Record<string, TelemetryProperty | undefined>;
export type TelemetryCapture = (
  event: TelemetryEvent,
  properties?: TelemetryProperties,
) => Promise<boolean> | boolean;
export interface TelemetryIntent {
  event: Extract<TelemetryEvent, 'instance_create_requested' | 'build_requested'>;
  properties: TelemetryProperties;
}

interface InstallationIdOptions {
  filePath?: string;
  uuid?: () => string;
}

interface CaptureOptions extends InstallationIdOptions {
  endpoint?: string;
  projectKey?: string;
  fetcher?: typeof fetch;
  installationId?: string;
  timeoutMs?: number;
}

const installationIdCache = new Map<string, string>();
const blockedPropertyName =
  /(?:api.?key|token|secret|password|hostname|email|repo|path|directory|command|arguments?|url)/i;

function installationFilePath(): string {
  return path.join(os.homedir(), '.lim', 'telemetry.json');
}

function isInstallationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function getOrCreateInstallationId(options: InstallationIdOptions = {}): string {
  const filePath = options.filePath ?? installationFilePath();
  const cached = installationIdCache.get(filePath);
  if (cached) {
    return cached;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      version?: unknown;
      installationId?: unknown;
    };
    if (parsed.version === INSTALLATION_FILE_VERSION && isInstallationId(parsed.installationId)) {
      installationIdCache.set(filePath, parsed.installationId);
      return parsed.installationId;
    }
  } catch {
    // Missing, unreadable, or malformed state is replaced best-effort below.
  }

  const installationId = (options.uuid ?? randomUUID)();
  installationIdCache.set(filePath, installationId);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: INSTALLATION_FILE_VERSION, installationId }), {
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } catch {
    // Telemetry state must never affect the CLI command.
  }
  return installationId;
}

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['LIM_DISABLE_TELEMETRY']);
}

export function getTelemetryInstallationId(): string | undefined {
  if (telemetryDisabled()) {
    return undefined;
  }
  return getOrCreateInstallationId();
}

function looksSensitive(value: string): boolean {
  return (
    value.length > 128 ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /(?:^|[\\/])\.\.?[\\/]/.test(value) ||
    /^(?:[a-z]:[\\/]|\/|~[\\/])/i.test(value) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

export function sanitizeTelemetryProperties(
  properties: TelemetryProperties,
): Record<string, TelemetryProperty> {
  const sanitized: Record<string, TelemetryProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (
      value === undefined ||
      blockedPropertyName.test(key) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && looksSensitive(value))
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function telemetryErrorCategory(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'unknown';
  }
  const value = error as { name?: unknown; code?: unknown; status?: unknown };
  if (value.name === 'AbortError' || value.name === 'TimeoutError') return 'timeout';
  if (value.code === 'EACCES' || value.code === 'EPERM') return 'permission';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND'].includes(String(value.code))) {
    return 'network';
  }
  if (value.status === 401 || value.status === 403) return 'authentication';
  if (value.status === 404) return 'not_found';
  if (value.status === 408) return 'timeout';
  if (value.status === 429) return 'rate_limited';
  if (typeof value.status === 'number' && value.status >= 400 && value.status < 500) return 'validation';
  if (typeof value.status === 'number' && value.status >= 500) return 'server';
  return 'unknown';
}

export function telemetryIntentForCommand(
  commandId: string,
  flags: Record<string, unknown>,
): TelemetryIntent | undefined {
  const [noun, verb] = commandId.split(/[: ]+/).filter(Boolean);
  if (noun && verb === 'create' && ['ios', 'android', 'xcode', 'gradle'].includes(noun)) {
    const createKind =
      (noun === 'xcode' && flags['ios']) || (noun === 'ios' && flags['xcode']) ? 'ios_with_xcode' : noun;
    return {
      event: 'instance_create_requested',
      properties: {
        platform: noun,
        create_kind: createKind,
        region_selected: typeof flags['region'] === 'string',
        reuse_requested: Boolean(flags['reuse-if-exists']),
      },
    };
  }
  if (verb === 'build' && (noun === 'xcode' || noun === 'gradle')) {
    return {
      event: 'build_requested',
      properties: {
        build_system: noun,
        detached: Boolean(flags['detach']),
        explicit_target: typeof flags['id'] === 'string',
      },
    };
  }
  return undefined;
}

function captureUrl(endpoint: string): URL | undefined {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/capture/`;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return undefined;
  }
}

export async function captureTelemetry(
  event: TelemetryEvent,
  properties: TelemetryProperties = {},
  options: CaptureOptions = {},
): Promise<boolean> {
  if (telemetryDisabled()) {
    return false;
  }

  const projectKey =
    options.projectKey ?? process.env['LIM_POSTHOG_PROJECT_KEY'] ?? DEFAULT_POSTHOG_PROJECT_KEY;
  const endpoint = options.endpoint ?? process.env['LIM_POSTHOG_HOST'] ?? DEFAULT_POSTHOG_HOST;
  const url = endpoint ? captureUrl(endpoint) : undefined;
  if (!projectKey || !url) {
    return false;
  }

  let distinctId: string;
  try {
    distinctId = options.installationId ?? getOrCreateInstallationId(options);
  } catch {
    return false;
  }

  const sanitized = sanitizeTelemetryProperties(properties);
  const organizationTid =
    typeof sanitized['organization_tid'] === 'string' ? sanitized['organization_tid'] : undefined;
  const payloadProperties: Record<string, unknown> = {
    distinct_id: distinctId,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    source: 'cli',
    cli_version: CLI_VERSION,
    os: process.platform,
    $process_person_profile: false,
    ...sanitized,
  };
  if (organizationTid && /^[a-zA-Z0-9_-]{1,128}$/.test(organizationTid)) {
    payloadProperties['$groups'] = { organization: organizationTid };
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('telemetry send timed out'));
      }, timeoutMs);
      timeout.unref?.();
    });
    const response = await Promise.race([
      (options.fetcher ?? fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: projectKey,
          event,
          properties: payloadProperties,
        }),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
