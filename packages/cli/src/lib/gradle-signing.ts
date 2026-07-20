import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GradleSigningConfig } from '@limrun/api';

import { generateAndroidSigningKey } from './android-keystore';
import type Limrun from '@limrun/api';

import { androidSigningKeySecretType, getSecret, putSecret, whoAmI } from './backend';

const signingFields = ['keystoreBase64', 'keystorePassword', 'keyAlias', 'keyPassword'] as const;

/**
 * Resolves the Android applicationId that names the escrowed signing key.
 * Precedence: explicit flag, Expo app config, Gradle build script. The
 * file probes are heuristics; --application-id is the escape hatch.
 */
export function resolveApplicationId(opts: {
  explicit?: string;
  syncPath: string;
  expoAppDir?: string;
  projectPath?: string;
}): string {
  if (opts.explicit) {
    return opts.explicit;
  }
  const fromExpo = expoAndroidPackage(path.join(opts.syncPath, opts.expoAppDir ?? '.'));
  if (fromExpo) {
    return fromExpo;
  }
  // Probe the explicit gradle root first, then the conventional bare
  // React Native layout (android/), which users rarely spell out because
  // the server auto-discovers it.
  for (const root of [...new Set([opts.projectPath ?? '.', 'android'])]) {
    const fromGradle = gradleApplicationId(path.join(opts.syncPath, root));
    if (fromGradle) {
      return fromGradle;
    }
  }
  throw new Error(
    'Cannot determine the Android application ID for signing. Pass --application-id <id> (the value of android.package in app.json, or applicationId in app/build.gradle).',
  );
}

function expoAndroidPackage(appDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(appDir, 'app.json'), 'utf8');
    const parsed = JSON.parse(raw) as { expo?: { android?: { package?: string } } };
    return parsed.expo?.android?.package || undefined;
  } catch {
    return undefined;
  }
}

function gradleApplicationId(gradleRoot: string): string | undefined {
  for (const candidate of ['app/build.gradle', 'app/build.gradle.kts']) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(gradleRoot, candidate), 'utf8');
    } catch {
      continue;
    }
    // Matches both Groovy (applicationId "com.x") and Kotlin DSL
    // (applicationId = "com.x"). First match wins; flavor-specific
    // overrides are out of heuristic scope.
    const match = content.match(/applicationId\s*=?\s*["']([A-Za-z0-9_.]+)["']/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Reads a bring-your-own keystore file into the wire signing shape. The
 * flag validator guarantees the passwords and alias are set; the checks
 * here keep that invariant local instead of relying on call-site order.
 */
export function readProvidedSigning(flags: {
  keystore: string;
  keystorePassword?: string;
  keyAlias?: string;
  keyPassword?: string;
}): GradleSigningConfig {
  const { keystorePassword, keyAlias, keyPassword } = flags;
  if (keystorePassword === undefined || keyAlias === undefined || keyPassword === undefined) {
    throw new Error(
      'Signing with your own key requires --keystore-password, --key-alias and --key-password.',
    );
  }
  let keystore: Buffer;
  try {
    keystore = fs.readFileSync(flags.keystore);
  } catch (err) {
    throw new Error(
      `Cannot read the keystore file ${flags.keystore}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (keystore.length === 0) {
    throw new Error(`The keystore file ${flags.keystore} is empty.`);
  }
  return {
    keystoreBase64: keystore.toString('base64'),
    keystorePassword,
    keyAlias,
    keyPassword,
  };
}

export type EscrowedSigning = {
  signing: GradleSigningConfig;
  /** True when this invocation created the key; false when it already existed. */
  created: boolean;
};

/**
 * Fetches the organization's upload key for the application, generating
 * and escrowing one on first use. The backend's get-or-create makes the
 * concurrent-first-build race safe: whichever caller wins, everyone signs
 * with the same key, because the response data is authoritative.
 */
export async function resolveEscrowedSigning(
  client: Limrun,
  applicationId: string,
): Promise<EscrowedSigning> {
  const organizationId = await whoAmI(client);
  const existing = await getSecret(client, organizationId, androidSigningKeySecretType, applicationId);
  if (existing) {
    return { signing: asSigningConfig(existing, applicationId), created: false };
  }
  const generated = generateAndroidSigningKey(applicationId);
  const result = await putSecret(
    client,
    organizationId,
    androidSigningKeySecretType,
    applicationId,
    generated,
  );
  return { signing: asSigningConfig(result.data, applicationId), created: result.created };
}

/**
 * Escrows a user-provided key under the application's name. Refuses to
 * proceed when a DIFFERENT key is already escrowed: silently signing with
 * either key would surprise someone, and replacing an upload key is not a
 * side effect a build command should have.
 */
export async function saveProvidedKey(
  client: Limrun,
  applicationId: string,
  provided: GradleSigningConfig,
): Promise<boolean> {
  const organizationId = await whoAmI(client);
  const result = await putSecret(
    client,
    organizationId,
    androidSigningKeySecretType,
    applicationId,
    provided,
  );
  if (!result.created && !signingFields.every((f) => result.data[f] === provided[f])) {
    throw new Error(
      `The organization already has a different upload key escrowed for ${applicationId}. ` +
        'Builds with --sign use that key; drop --save-key to sign with the provided keystore for this build only.',
    );
  }
  return result.created;
}

function asSigningConfig(data: Record<string, string>, applicationId: string): GradleSigningConfig {
  if (signingFields.some((f) => !data[f])) {
    throw new Error(
      `The escrowed signing key for ${applicationId} is missing required fields; contact support before retrying.`,
    );
  }
  const { keystoreBase64, keystorePassword, keyAlias, keyPassword } = data;
  return { keystoreBase64, keystorePassword, keyAlias, keyPassword };
}
