import path from 'node:path';
import os from 'node:os';
import { runMaestroIos } from './run';

const defaultTimeoutMs = 10 * 60 * 1000;

type ParsedArgs = {
  command: 'test';
  artifactsDir: string;
  flowPath: string;
  timeoutMs: number;
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const parsed = parseArgs(argv);
    const apiUrl = process.env['LIMRUN_IOS_API_URL'];
    const token = process.env['LIMRUN_IOS_TOKEN'];
    if (!apiUrl || !token) {
      throw new Error('Missing required environment variables LIMRUN_IOS_API_URL and LIMRUN_IOS_TOKEN.');
    }

    await runMaestroIos({
      apiUrl,
      artifactsDir: parsed.artifactsDir,
      flowPath: parsed.flowPath,
      token,
      timeoutMs: parsed.timeoutMs,
    });
  } catch (error) {
    if (error instanceof SilentExit) {
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exitCode = 0;
    throw new SilentExit();
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    // Keep the package version in package.json as the source of truth for release tooling.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    console.log(require('../package.json').version);
    process.exitCode = 0;
    throw new SilentExit();
  }

  const [command, ...rest] = argv;
  if (command !== 'test') {
    throw new Error(`Expected command: test <flow.yaml>\n\n${usage()}`);
  }

  let flowPath: string | undefined;
  let testOutputDir = defaultTestOutputDir();
  const timeoutMs = timeoutFromEnv();

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--test-output-dir=')) {
      testOutputDir = arg.slice('--test-output-dir='.length);
      if (!testOutputDir) {
        throw new Error('Missing value for --test-output-dir');
      }
      continue;
    }

    switch (arg) {
      case '--test-output-dir': {
        const value = rest[++i];
        if (!value) {
          throw new Error('Missing value for --test-output-dir');
        }
        testOutputDir = value;
        break;
      }
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (flowPath) {
          throw new Error(`Only one flow file is supported in this release. Unexpected argument: ${arg}`);
        }
        flowPath = arg;
    }
  }

  if (!flowPath) {
    throw new Error(`Missing flow file.\n\n${usage()}`);
  }

  return {
    command: 'test',
    artifactsDir: path.resolve(testOutputDir),
    flowPath: path.resolve(flowPath),
    timeoutMs,
  };
}

function printHelp(): void {
  console.log(usage());
}

function usage(): string {
  return `Usage:
  npx @limrun/maestro-ios test [--test-output-dir <dir>] <flow.yaml>

Environment:
  LIMRUN_IOS_API_URL   Required existing Limrun iOS instance API URL
  LIMRUN_IOS_TOKEN     Required existing Limrun iOS instance token`;
}

function defaultTestOutputDir(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.homedir(), '.maestro', 'tests', `limrun-ios-${timestamp}`);
}

function timeoutFromEnv(): number {
  const value = process.env['LIMRUN_MAESTRO_TIMEOUT_MS'];
  if (!value) {
    return defaultTimeoutMs;
  }

  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('LIMRUN_MAESTRO_TIMEOUT_MS must be a positive integer');
  }
  return timeoutMs;
}

class SilentExit extends Error {
  constructor() {
    super('silent exit');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
