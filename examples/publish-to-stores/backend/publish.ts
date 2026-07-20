// Runs one publish: materializes the stored signing secrets into temp files,
// spawns `lim xcode build ... --upload-to-testflight --auto-build-number`, and
// streams its output as Server-Sent Events. Both the TestFlight and App Store
// methods run the same upload — an App Store release is the same App Store
// Connect upload followed by submitting the processed build to review in the
// App Store Connect UI.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
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
export async function ensureExpoBundleIdentifier(
  projectPath: string,
  bundleId: string,
): Promise<string[]> {
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

/**
 * Spawns the CLI and streams stdout/stderr lines plus the exit code to the
 * response as SSE events (`stdout`, `stderr`, `exit`, `error`). Temp files
 * holding the materialized secrets are removed when the process ends.
 */
export async function streamPublish(request: PublishRequest, res: Response): Promise<void> {
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

  let workDir: string | undefined;
  try {
    const { certificate, profile, apiKey } = await resolvePublishCredentials(
      request.teamId,
      request.bundleId,
    );

    workDir = await mkdtemp(path.join(os.tmpdir(), 'publish-to-stores-'));
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
    ];
    if (apiKey.data.issuerId) {
      args.push('--asc-issuer-id', apiKey.data.issuerId);
    }
    if (request.scheme) {
      args.push('--scheme', request.scheme);
    }

    send('stdout', `Publishing ${request.bundleId} via ${request.method}...`);
    for (const line of await ensureExpoBundleIdentifier(request.projectPath, request.bundleId)) {
      send('stdout', line);
    }
    send('stdout', `$ lim ${args.join(' ')}`);
    const child = spawn('lim', args, { env: process.env });

    const forwardLines = (event: 'stdout' | 'stderr') => {
      let buffered = '';
      return (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) send(event, line);
      };
    };
    child.stdout.on('data', forwardLines('stdout'));
    child.stderr.on('data', forwardLines('stderr'));
    child.on('error', (error) => {
      send('error', `Failed to run the lim CLI: ${error.message}. Is it installed and on PATH?`);
      res.end();
    });
    child.on('close', (code) => {
      if (request.method === 'appstore' && code === 0) {
        send(
          'stdout',
          'Upload complete. To release on the App Store, open App Store Connect, attach the ' +
            'processed build to a version, and submit it for review.',
        );
      }
      send('exit', String(code ?? 1));
      res.end();
    });
    // A closed browser tab must not leave a build running unattended.
    res.on('close', () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    });
  } catch (error) {
    send('error', error instanceof Error ? error.message : 'Publish failed');
    res.end();
  } finally {
    if (workDir) {
      const cleanup = workDir;
      res.on('close', () => {
        void rm(cleanup, { recursive: true, force: true });
      });
    }
  }
}
