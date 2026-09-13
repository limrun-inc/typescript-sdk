import { Flags } from '@oclif/core';
import type { RunArtifactOutput, XcodeArtifactOutput } from '@limrun/api';

export const artifactOutputFlags = {
  output: Flags.string({
    description:
      'Named output as NAME=workspace:PATH, NAME=testProducts, or NAME=resultBundle. Repeat for multiple. Unless --output-url overrides it, NAME is also the Limrun asset name.',
    multiple: true,
    multipleNonGreedy: true,
  }),
  'output-url': Flags.string({
    description:
      'Caller-minted upload destination as NAME=HTTPS_URL for an output declared by --output. Repeat for multiple. Everything after the first = is preserved, including signed URL query strings.',
    multiple: true,
    multipleNonGreedy: true,
    dependsOn: ['output'],
  }),
  'output-ttl': Flags.string({
    description:
      'TTL for output assets as a Go duration (for example 24h). Defaults to 336h (14 days). Does not apply to outputs with --output-url.',
    dependsOn: ['output'],
  }),
};

export type ArtifactOutputFlagValues = {
  output?: string[];
  'output-url'?: string[];
  'output-ttl'?: string;
};

export function artifactOutputsFromFlags(flags: ArtifactOutputFlagValues, mode: 'run'): RunArtifactOutput[];
export function artifactOutputsFromFlags(
  flags: ArtifactOutputFlagValues,
  mode: 'build' | 'test',
): XcodeArtifactOutput[];
export function artifactOutputsFromFlags(
  flags: ArtifactOutputFlagValues,
  mode: 'run' | 'build' | 'test',
): XcodeArtifactOutput[] {
  const descriptors = flags.output ?? [];
  if (descriptors.length === 0) {
    return [];
  }
  if (descriptors.length > 8) {
    throw new Error('--output may be repeated at most 8 times.');
  }

  const destinations = new Map<string, string>();
  for (const value of flags['output-url'] ?? []) {
    const [name, url] = splitNamedValue(value, '--output-url');
    if (destinations.has(name)) {
      throw new Error(`--output-url names output ${JSON.stringify(name)} more than once.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`--output-url for ${JSON.stringify(name)} must be an absolute HTTPS URL.`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`--output-url for ${JSON.stringify(name)} must be an absolute HTTPS URL.`);
    }
    destinations.set(name, url);
  }

  const names = new Set<string>();
  const outputs = descriptors.map((value): XcodeArtifactOutput => {
    const [name, descriptor] = splitNamedValue(value, '--output');
    if (Buffer.byteLength(name) > 128 || name.includes('\0')) {
      throw new Error('--output NAME must contain 1 to 128 non-NUL bytes.');
    }
    if (names.has(name)) {
      throw new Error(`--output names ${JSON.stringify(name)} more than once.`);
    }
    names.add(name);

    const destination =
      destinations.has(name) ?
        { signedUploadUrl: destinations.get(name)! }
      : { assetName: name, ...(flags['output-ttl'] && { ttl: flags['output-ttl'] }) };

    if (descriptor.startsWith('workspace:')) {
      const path = descriptor.slice('workspace:'.length);
      if (
        !path ||
        Buffer.byteLength(path) > 512 ||
        path.startsWith('/') ||
        path.includes('\0') ||
        path.split('/').includes('..')
      ) {
        throw new Error(
          `--output ${JSON.stringify(
            name,
          )} workspace path must be relative, non-empty, at most 512 bytes, and contain no .. segment.`,
        );
      }
      return { name, source: 'workspace', path, ...destination };
    }
    if (descriptor === 'testProducts') {
      if (mode !== 'test') {
        throw new Error(
          `--output ${JSON.stringify(name)} uses testProducts, which is only valid with lim xcode test.`,
        );
      }
      return { name, source: 'testProducts', ...destination };
    }
    if (descriptor === 'resultBundle') {
      if (mode === 'run') {
        throw new Error(
          `--output ${JSON.stringify(
            name,
          )} uses resultBundle, which is only valid with xcode build or xcode test.`,
        );
      }
      return { name, source: 'resultBundle', ...destination };
    }
    throw new Error(
      `--output ${JSON.stringify(name)} source must be workspace:PATH, testProducts, or resultBundle.`,
    );
  });

  for (const name of destinations.keys()) {
    if (!names.has(name)) {
      throw new Error(`--output-url names undeclared output ${JSON.stringify(name)}.`);
    }
  }
  if (flags['output-ttl'] && destinations.size === outputs.length) {
    throw new Error('--output-ttl has no effect because every output uses --output-url.');
  }
  return outputs;
}

function splitNamedValue(value: string, flag: '--output' | '--output-url'): [string, string] {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${flag} must be NAME=VALUE, got ${JSON.stringify(value)}.`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}
