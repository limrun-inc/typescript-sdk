import { spawnSync } from 'node:child_process';

export function parseJavaMajorVersion(output: string): number | null {
  const version = output.match(/version\s+"([^"]+)"/)?.[1] ?? output.match(/openjdk\s+([0-9][^\s]*)/)?.[1];
  if (!version) {
    return null;
  }

  const parts = version.split(/[._-]/);
  const first = Number(parts[0]);
  if (!Number.isInteger(first)) {
    return null;
  }

  if (first === 1) {
    const second = Number(parts[1]);
    return Number.isInteger(second) ? second : null;
  }

  return first;
}

export function assertJava17OnPath(): void {
  const result = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      'Java 17 or newer is required to run @limrun/maestro-ios. Install a JDK and ensure `java` is available on PATH.',
    );
  }

  const versionOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const majorVersion = parseJavaMajorVersion(versionOutput);
  if (!majorVersion || majorVersion < 17) {
    throw new Error(
      `Java 17 or newer is required to run @limrun/maestro-ios. Detected: ${versionOutput.trim() || 'unknown java -version output'}`,
    );
  }
}
