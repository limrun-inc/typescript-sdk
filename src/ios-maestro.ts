import path from 'path';
import net from 'net';
import { execFile } from 'child_process';

import type { InstanceClient } from './ios-client';

export const MAESTRO_RUNNER_BUNDLE_ID = 'dev.mobile.maestro-driver-iosUITests.xctrunner';
/** Port the patched Maestro XCTest runner listens on inside the simulator. */
export const MAESTRO_RUNNER_PORT = 22087;

// Maestro installs as a .bat/.cmd wrapper on Windows, which spawn can only
// execute through a shell.
export const maestroSpawnOptions = { shell: process.platform === 'win32' } as const;

export type MaestroRun = {
  maestroVersion: string;
  driverPort: number;
  /** Environment overrides for the `maestro` process; merge over process.env. */
  env: Record<string, string>;
  /** Arguments to place between `maestro test` and the flow arguments. */
  args: string[];
};

/**
 * Wire a locally installed stock Maestro CLI to this instance's remote XCTest
 * runner: starts the xcrun shim and an HTTP forward proxy, and returns the
 * environment and `maestro test` arguments that route the driver traffic to
 * the remote runner. Both are torn down when the client disconnects.
 *
 * Maestro's driver talks plain HTTP to 127.0.0.1:<driverPort>. Nothing listens
 * there: the JVM proxy settings route those requests (absolute-form) to the
 * forward proxy, which rewrites them to the remote runner and passes other
 * targets through.
 */
export async function prepareMaestroRun(
  client: InstanceClient,
  options: { runnerUrl: string },
): Promise<MaestroRun> {
  const [maestroVersion, shimDir] = await Promise.all([detectMaestroVersion(), client.startXcrunShim()]);
  // Maestro 2.5.x hardcodes driver port 7001 and has no --driver-host-port
  // flag; 2.6+ picks a random port unless the flag is passed.
  const withDriverHostPortFlag = supportsDriverHostPort(maestroVersion);
  const driverPort = withDriverHostPortFlag ? await findFreePort() : 7001;
  const proxyPort = await client.startForwardHttpProxy({
    remoteBaseUrl: options.runnerUrl,
    matchPort: driverPort,
  });
  const maestroOpts = [
    process.env['MAESTRO_OPTS'],
    `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${proxyPort} -Dhttp.nonProxyHosts=`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    maestroVersion,
    driverPort,
    env: {
      MAESTRO_OPTS: maestroOpts,
      PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      USE_XCODE_TEST_RUNNER: '1',
    },
    args: [
      '--platform',
      'ios',
      '--device',
      client.deviceInfo.udid,
      '--no-reinstall-driver',
      ...(withDriverHostPortFlag ? ['--driver-host-port', String(driverPort)] : []),
    ],
  };
}

/** Poll the remote Maestro XCTest runner until it responds, e.g. right after launching it. */
export async function waitForMaestroRunner(
  runnerUrl: string,
  token: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isMaestroRunnerRunning(runnerUrl, token)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** Probe the remote Maestro XCTest runner's /status endpoint. */
export async function isMaestroRunnerRunning(runnerUrl: string, token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${runnerUrl}/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

function detectMaestroVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('maestro', ['--version'], { encoding: 'utf8', ...maestroSpawnOptions }, (error, stdout) => {
      if (error) {
        reject(
          new Error(
            'Failed to run `maestro --version`. Install the Maestro CLI first: https://docs.maestro.dev/getting-started/installing-maestro',
          ),
        );
        return;
      }
      // stdout only: update notices can also start with a version string and
      // land on stderr or after the real version.
      const version = stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^\d+\.\d+\.\d+/.test(line));
      if (!version) {
        reject(new Error('Could not parse the Maestro CLI version from `maestro --version` output.'));
        return;
      }
      resolve(version);
    });
  });
}

function supportsDriverHostPort(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 2 || (major === 2 && minor >= 6);
}

// Finds a free port and releases it immediately: Maestro validates that the
// driver port is bindable, so it must stay unbound on our side.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to find a free port.'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
