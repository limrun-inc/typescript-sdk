import { resolveLocalDetoxVersion } from './detox-version';

export type LaunchAppMode = 'ForegroundIfRunning' | 'RelaunchIfRunning';
export type LaunchAppRuntime = {
  kind: 'detox';
  serverUrl: string;
  sessionId: string;
  version: string;
};
export type LaunchAppArgument =
  | LaunchAppMode
  | {
      mode: 'RelaunchIfRunning';
      runtime: LaunchAppRuntime;
    };

export type LaunchAppFlagValues = {
  mode?: LaunchAppMode;
  runtime?: string;
  'detox-server-url'?: string;
  'detox-session-id'?: string;
  'detox-version'?: string;
};

const DETOX_FLAG_NAMES = ['--detox-server-url', '--detox-session-id', '--detox-version'] as const;

function validateDetoxServerUrl(serverUrl: string): void {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error(`--detox-server-url must be a valid ws:// or wss:// URL, got: ${serverUrl}`);
  }

  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname) {
    throw new Error(`--detox-server-url must be a valid ws:// or wss:// URL, got: ${serverUrl}`);
  }
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

export function buildLaunchAppArgument(
  flags: LaunchAppFlagValues,
  options: { modeExplicitlyProvided: boolean; cwd?: string },
): LaunchAppArgument {
  const hasDetoxFlag =
    flags['detox-server-url'] !== undefined ||
    flags['detox-session-id'] !== undefined ||
    flags['detox-version'] !== undefined;

  if (!flags.runtime) {
    if (hasDetoxFlag) {
      throw new Error(`${DETOX_FLAG_NAMES.join(', ')} require --runtime detox.`);
    }
    return flags.mode ?? 'ForegroundIfRunning';
  }

  if (flags.runtime !== 'detox') {
    throw new Error(`Unsupported runtime: ${flags.runtime}`);
  }

  if (options.modeExplicitlyProvided && flags.mode === 'ForegroundIfRunning') {
    throw new Error('Detox runtime launches require RelaunchIfRunning so runtime injection is applied.');
  }

  const serverUrl = flags['detox-server-url'];
  const sessionId = flags['detox-session-id'];
  if (!nonEmpty(serverUrl)) {
    throw new Error('--runtime detox requires --detox-server-url.');
  }
  if (!nonEmpty(sessionId)) {
    throw new Error('--runtime detox requires --detox-session-id.');
  }

  validateDetoxServerUrl(serverUrl);
  const providedVersion = flags['detox-version'];
  const version = nonEmpty(providedVersion) ? providedVersion : resolveLocalDetoxVersion(options.cwd);

  return {
    mode: 'RelaunchIfRunning',
    runtime: {
      kind: 'detox',
      serverUrl,
      sessionId,
      version,
    },
  };
}
