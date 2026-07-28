import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import os from 'os';
import path from 'path';

import type { InstalledApp, InstanceClient } from './ios-client';

const FORWARDED_SIMCTL_COMMANDS = new Set([
  'openurl',
  'launch',
  'terminate',
  'uninstall',
  'privacy',
  'location',
  'status_bar',
]);

export type IosXcrunShimServer = {
  url: string;
  close: () => Promise<void>;
};

export type IosXcrunShim = {
  dir: string;
  close: () => Promise<void>;
};

export type IosXcrunShimClient = Pick<InstanceClient, 'deviceInfo' | 'listApps' | 'simctl' | 'syncApp'>;

export type IosShimSimctlResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function startXcrunShim(client: IosXcrunShimClient): Promise<IosXcrunShim> {
  const server = await startXcrunShimServer({ client, udid: client.deviceInfo.udid });
  try {
    const dir = await createXcrunShim({ shimUrl: server.url, udid: client.deviceInfo.udid });
    return {
      dir,
      close: async () => {
        await server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

export async function startXcrunShimServer({
  client,
  udid,
}: {
  client: IosXcrunShimClient;
  udid: string;
}): Promise<IosXcrunShimServer> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/xcrun') {
      sendJson(res, 404, { code: 127, stdout: '', stderr: 'not found' });
      return;
    }
    try {
      const body = (await readJson(req)) as { args?: string[] };
      const args = body.args ?? [];
      const result = await handleShimmedXcrun(client, udid, args);
      sendJson(res, 200, result);
    } catch {
      sendJson(res, 200, {
        code: 1,
        stdout: '',
        stderr: 'limrun xcrun shim failed to execute the requested command.',
      });
    }
  });

  await listen(server, 0);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start Limrun xcrun shim server.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/xcrun`,
    close: () => closeServer(server),
  };
}

export async function createXcrunShim(options?: { shimUrl: string; udid: string }): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-xcrun-shim-'));
  const shimPath = path.join(dir, 'xcrun');
  fs.writeFileSync(shimPath, xcrunShimSource(options), 'utf8');
  fs.chmodSync(shimPath, 0o755);
  return dir;
}

async function handleShimmedXcrun(
  client: IosXcrunShimClient,
  udid: string,
  args: string[],
): Promise<IosShimSimctlResult> {
  if (args[0] === 'devicectl') {
    return devicectlListDevices(args);
  }
  if (args[0] !== 'simctl') {
    return { code: 127, stdout: '', stderr: `unsupported xcrun command: ${args.join(' ')}` };
  }

  const simctlArgs = args.slice(1);
  const command = simctlArgs[0];
  const target = simctlTarget(command, simctlArgs);

  if (command === 'list') {
    // Maestro's device picker expects the full CoreSimulator JSON shape. Limrun
    // only has one remote simulator in this context, so we synthesize that entry.
    return simctlList(client.deviceInfo.udid, simctlArgs);
  }

  if (!isLimrunTarget(target, udid)) {
    return { code: 64, stdout: '', stderr: `unsupported non-Limrun simctl target '${target ?? ''}'.` };
  }

  if (command === 'listapps') {
    const apps = await client.listApps();
    return {
      code: 0,
      stdout: `${JSON.stringify(toSimctlListApps(apps))}\n`,
      stderr: '',
    };
  }

  if (command === 'install') {
    const appPath = simctlArgs[2];
    if (!appPath) {
      return { code: 64, stdout: '', stderr: 'simctl install requires a local .app path.' };
    }
    await client.syncApp(appPath, { install: true, watch: false });
    return { code: 0, stdout: '', stderr: '' };
  }

  const unsupported = unsupportedPathBearingCommand(command);
  if (unsupported) {
    return unsupported;
  }

  if (!command || !FORWARDED_SIMCTL_COMMANDS.has(command)) {
    return { code: 64, stdout: '', stderr: `limrun xcrun shim does not support simctl ${command ?? ''}.` };
  }

  return await client.simctl(simctlArgs).wait();
}

// There are never physical devices behind the shim, so `devicectl list
// devices` gets an empty device list in the shape Maestro's picker parses.
// Flags can precede the subcommand (devicectl --json-output <path> list
// devices), so match on positionals.
function devicectlListDevices(args: string[]): IosShimSimctlResult {
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json-output') {
      i++;
      continue;
    }
    if (args[i]!.startsWith('-')) continue;
    positionals.push(args[i]!);
  }
  if (positionals[0] !== 'list' || positionals[1] !== 'devices') {
    return { code: 127, stdout: '', stderr: `unsupported devicectl command: ${args.join(' ')}` };
  }
  const payload = JSON.stringify({ result: { devices: [] } });
  const jsonOutIndex = args.indexOf('--json-output');
  const jsonOutPath = jsonOutIndex === -1 ? undefined : args[jsonOutIndex + 1];
  if (jsonOutPath && jsonOutPath !== '-') {
    try {
      fs.writeFileSync(jsonOutPath, payload);
    } catch (error) {
      return {
        code: 1,
        stdout: '',
        stderr: `could not write devicectl output to ${jsonOutPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  return { code: 0, stdout: `${payload}\n`, stderr: '' };
}

function simctlList(udid: string, simctlArgs: string[]): IosShimSimctlResult {
  if (!simctlArgs.includes('-j')) {
    return { code: 64, stdout: '', stderr: 'limrun xcrun shim only supports `xcrun simctl list -j`.' };
  }
  return {
    code: 0,
    stdout: `${JSON.stringify(toSimctlList(udid))}\n`,
    stderr: '',
  };
}

function unsupportedPathBearingCommand(command: string | undefined): IosShimSimctlResult | undefined {
  // These commands either return local simulator filesystem paths or consume
  // host-side media files. They need explicit staging/translation before they
  // are safe to claim as supported.
  if (command === 'get_app_container') {
    return {
      code: 64,
      stdout: '',
      stderr:
        'limrun xcrun shim does not support get_app_container because upstream tools expect a local filesystem path.',
    };
  }
  if (command === 'keychain') {
    return { code: 64, stdout: '', stderr: 'limrun xcrun shim does not support simctl keychain in v1.' };
  }
  if (command === 'io') {
    return {
      code: 64,
      stdout: '',
      stderr: 'limrun xcrun shim does not support simctl io recordVideo in v1.',
    };
  }
  if (command === 'push' || command === 'addmedia') {
    return {
      code: 64,
      stdout: '',
      stderr: `limrun xcrun shim does not support path-bearing simctl ${command} in v1.`,
    };
  }
  return undefined;
}

function isLimrunTarget(value: string | undefined, udid: string): boolean {
  return value === udid || value === 'booted';
}

function simctlTarget(command: string | undefined, simctlArgs: string[]): string | undefined {
  if (command === 'launch') {
    return simctlArgs.slice(1).find((arg) => !arg.startsWith('-'));
  }
  return simctlArgs[1];
}

function toSimctlList(udid: string): Record<string, unknown> {
  const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-18-0';
  const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro';
  return {
    devices: {
      [runtimeIdentifier]: [
        {
          availability: '(available)',
          dataPath: `/tmp/limrun-sim/${udid}/data`,
          logPath: `/tmp/limrun-sim/${udid}/logs`,
          isAvailable: true,
          name: process.env['LIMRUN_IOS_DEVICE_NAME'] || 'Limrun iPhone',
          state: 'Booted',
          udid,
          deviceTypeIdentifier,
          availabilityError: null,
        },
      ],
    },
    devicetypes: [
      {
        bundlePath: '',
        identifier: deviceTypeIdentifier,
        maxRuntimeVersion: 999999,
        maxRuntimeVersionString: null,
        minRuntimeVersion: 0,
        minRuntimeVersionString: null,
        modelIdentifier: 'iPhone17,1',
        name: 'iPhone 16 Pro',
        productFamily: 'iPhone',
      },
    ],
    pairs: {},
    runtimes: [
      {
        availability: '(available)',
        bundlePath: '',
        buildversion: '22A000',
        identifier: runtimeIdentifier,
        isInternal: false,
        isAvailable: true,
        name: process.env['LIMRUN_IOS_RUNTIME_NAME'] || 'iOS 18.0',
        platform: 'iOS',
        runtimeRoot: '',
        supportedDeviceTypes: [],
        version: '18.0',
      },
    ],
  };
}

function toSimctlListApps(
  apps: InstalledApp[],
): Record<string, { CFBundleIdentifier: string; CFBundleName?: string }> {
  return Object.fromEntries(
    apps.map((app) => [
      app.bundleId,
      {
        CFBundleIdentifier: app.bundleId,
        ...(app.name ? { CFBundleName: app.name } : {}),
      },
    ]),
  );
}

function xcrunShimSource(options?: { shimUrl: string; udid: string }): string {
  // Keep the executable tiny: it decides whether this is a Limrun-targeted
  // simctl call (or a devicectl device enumeration), then asks the local shim
  // server to perform the real work. Non-Limrun calls still delegate to the
  // host xcrun.
  const embeddedShimUrl = options ? JSON.stringify(options.shimUrl) : 'process.env.LIMRUN_XCRUN_SHIM_URL';
  const embeddedUdid = options ? JSON.stringify(options.udid) : 'process.env.LIMRUN_IOS_UDID';
  return `#!/usr/bin/env node
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const realXcrun = process.env.LIMRUN_REAL_XCRUN || '/usr/bin/xcrun';

function delegate() {
  const result = spawnSync(realXcrun, args, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(String(result.error.message || result.error) + '\\n');
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}

function fail(message) {
  process.stderr.write('limrun xcrun shim: ' + message + '\\n');
  process.exit(64);
}

// Physical-device enumeration (e.g. Maestro's device picker) is answered by
// the shim server; real devicectl does not exist off macOS. Every other
// devicectl subcommand delegates. Flags can precede the subcommand
// (devicectl --json-output <path> list devices), so match on positionals.
function devicectlPositionals(args) {
  const positionals = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json-output') {
      i++;
      continue;
    }
    if (args[i].startsWith('-')) continue;
    positionals.push(args[i]);
  }
  return positionals;
}
const devicectlSubcommand = args[0] === 'devicectl' ? devicectlPositionals(args) : [];
const isDevicectlListDevices = devicectlSubcommand[0] === 'list' && devicectlSubcommand[1] === 'devices';

if (args[0] !== 'simctl' && !isDevicectlListDevices) {
  delegate();
}

const shimUrl = ${embeddedShimUrl};
const udid = ${embeddedUdid};
if (!shimUrl || !udid) {
  fail('LIMRUN_XCRUN_SHIM_URL and LIMRUN_IOS_UDID are required.');
}

function simctlTarget(command, simctlArgs) {
  if (command === 'launch') {
    return simctlArgs.slice(1).find((arg) => !arg.startsWith('-'));
  }
  return simctlArgs[1];
}
function isLimrunTarget(value) {
  return value === udid || value === 'booted';
}

if (args[0] === 'simctl') {
  const simctlArgs = args.slice(1);
  const command = simctlArgs[0];
  const target = simctlTarget(command, simctlArgs);
  if (command !== 'list' && !isLimrunTarget(target)) {
    delegate();
  }
}

const parsed = new URL(shimUrl);
const body = JSON.stringify({ args });
const req = http.request(parsed, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  },
}, (res) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      process.stderr.write('limrun xcrun shim: invalid shim response\\n');
      process.exit(1);
    }
    if (payload.stdout) process.stdout.write(payload.stdout);
    if (payload.stderr) process.stderr.write(payload.stderr);
    process.exit(typeof payload.code === 'number' ? payload.code : 1);
  });
});
req.on('error', (error) => {
  process.stderr.write('limrun xcrun shim: ' + error.message + '\\n');
  process.exit(1);
});
req.end(body);
`;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
