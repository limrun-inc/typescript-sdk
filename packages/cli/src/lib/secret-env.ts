/** Parse names literally, including slashes and colons; never accept wildcard delegation here. */
export function parseSecretEnv(entries: string[] | undefined): Record<string, string> | undefined {
  if (!entries?.length) return undefined;
  const result: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    const index = entry.indexOf('=');
    const key = entry.slice(0, index);
    const name = entry.slice(index + 1);
    if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || !name || /[*?\0\r\n]/.test(name)) {
      throw new Error('Use --env-from-secret NAME=secret/name. Names must be literal, without * or ?.');
    }
    if (
      /^(DYLD_|LD_|LIMRUN_|SIMCTL_CHILD_|__DYLD_|__XPC_|XPC_DYLD_|SWIFT_DEBUG_)/i.test(key) ||
      [
        'NODE_BINARY',
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'TMPDIR',
        'TMP',
        'TEMP',
        'DEVELOPER_DIR',
        'ANDROID_HOME',
        'ANDROID_SDK_ROOT',
      ].includes(key)
    ) {
      throw new Error(`--env-from-secret cannot override managed variable ${key}.`);
    }
    if (Object.prototype.hasOwnProperty.call(result, key))
      throw new Error(`Duplicate secret binding for ${key}.`);
    result[key] =
      /^secret_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(name) || name.startsWith('name/') ? name : `name/${name}`;
    if (result[key] === 'name/' || result[key]!.length > 517) throw new Error('Invalid secret name.');
  }
  if (Object.keys(result).length > 64) throw new Error('At most 64 secret bindings are supported.');
  return result;
}

export function secretReadPermissions(bindings: Record<string, string> | undefined): string[] {
  return [...new Set(Object.values(bindings ?? {}).map((target) => `secret:${target}:read`))];
}

export function permissionCovers(existing: string, requested: string): boolean {
  if (existing === requested) return true;
  const split = (value: string) => [
    value.slice(0, value.indexOf(':')),
    value.slice(value.indexOf(':') + 1, value.lastIndexOf(':')),
    value.slice(value.lastIndexOf(':') + 1),
  ];
  const [resource, target, action] = split(existing);
  const [wantedResource, wantedTarget, wantedAction] = split(requested);
  if (resource !== wantedResource || (action !== 'all' && action !== wantedAction)) return false;
  if (target === '*' || target === wantedTarget) return true;
  if (!target?.startsWith('name/') || !wantedTarget?.startsWith('name/')) return false;
  const pattern = target
    .split('')
    .map((c) =>
      c === '*' ? '.*'
      : c === '?' ? '.'
      : c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${pattern}$`, 's').test(wantedTarget);
}

/** Keep ~/ literal so it resolves against the remote workload home. */
export function parseSecretFiles(entries: string[] | undefined): Record<string, string> | undefined {
  if (!entries?.length) return undefined;
  const result: Record<string, string> = Object.create(null);
  for (const entry of entries) {
    const i = entry.indexOf('=');
    const destination = entry.slice(0, i);
    const relative = destination.startsWith('~/') ? destination.slice(2) : destination;
    if (
      i < 1 ||
      destination.length > 1024 ||
      relative.startsWith('/') ||
      relative.startsWith('~') ||
      /[\\\0\r\n]/.test(relative) ||
      relative.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw new Error(
        "Use --file-from-secret '~/path=secret/name' or 'relative/path=secret/name'; quote ~/ to keep it remote.",
      );
    if (Object.prototype.hasOwnProperty.call(result, destination))
      throw new Error('Duplicate secret file destination.');
    result[destination] = parseSecretEnv(['SECRET_FILE=' + entry.slice(i + 1)])!['SECRET_FILE']!;
  }
  if (Object.keys(result).length > 64) throw new Error('At most 64 secret files are supported.');
  return result;
}
