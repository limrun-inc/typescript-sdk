import fs from 'fs';
import path from 'path';

/** What a project is, wherever it is checked out. */
export type ProjectIdentity = {
  /** Origin host and repository path, without credentials or the .git suffix. */
  repository: string;
  /** Path from the checkout root to the project, with forward slashes. Empty at the root. */
  directory: string;
};

/**
 * Identify a project from its Git checkout, so clones and worktrees of one repository agree.
 * Reads repository-local files only. Returns undefined outside a checkout, without an origin,
 * or when the metadata cannot be read with confidence.
 */
export function projectIdentity(projectPath: string): ProjectIdentity | undefined {
  try {
    const cwd = fs.realpathSync(projectPath);
    const checkout = findCheckout(cwd);
    if (!checkout) return undefined;
    const { root, gitDir } = checkout;
    const common = readOptional(path.join(gitDir, 'commondir'))?.trim();
    const commonDir = common ? path.resolve(gitDir, common) : gitDir;
    const config = parseConfig(readOptional(path.join(commonDir, 'config')) ?? '');
    if (/^(true|yes|on|1)$/i.test(config.get('extensions.worktreeconfig')?.slice(-1)[0] ?? '')) {
      for (const [name, values] of parseConfig(readOptional(path.join(gitDir, 'config.worktree')) ?? '')) {
        config.set(name, [...(config.get(name) ?? []), ...values]);
      }
    }
    // Git fetch uses the first URL when a remote declares more than one.
    const origin = config.get('remote.origin.url')?.[0];
    if (!origin) return undefined;
    const repository = repositoryIdentity(origin);
    if (!repository) return undefined;
    const directory = path.relative(root, cwd).split(path.sep).join('/');
    if (directory === '..' || directory.startsWith('../')) return undefined;
    return { repository, directory };
  } catch {
    // Missing or unsupported metadata leaves the project unidentified.
    return undefined;
  }
}

/**
 * Name the folder a project syncs into. A checkout at the repository root is named after the
 * repository, not after the local folder, so every clone and worktree lands in the same place
 * and reuses the same build state. Returns undefined when the project cannot be identified.
 */
export function projectFolderName(projectPath: string): string | undefined {
  const project = projectIdentity(projectPath);
  if (!project) return undefined;
  const name = path.posix.basename(project.directory || project.repository);
  return /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(name) ? name : undefined;
}

function findCheckout(start: string): { root: string; gitDir: string } | undefined {
  for (let root = start; ; root = path.dirname(root)) {
    const marker = path.join(root, '.git');
    if (fs.lstatSync(marker, { throwIfNoEntry: false })) {
      if (fs.statSync(marker).isDirectory()) return { root, gitDir: marker };
      const gitFile = /^gitdir: (.+)$/.exec(fs.readFileSync(marker, 'utf8').trim());
      // A broken nested checkout must not inherit the parent repository's key.
      if (!gitFile) return undefined;
      return { root, gitDir: path.resolve(root, gitFile[1]!) };
    }
    if (path.dirname(root) === root) return undefined;
  }
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Read repository-local settings without inheriting machine-specific Git configuration. */
function parseConfig(text: string): Map<string, string[]> {
  const config = new Map<string, string[]>();
  let section = '';
  for (let line of configLines(text)) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      const header = /^\[([\w.-]+)(?:[ \t]+"((?:[^"\\]|\\.)*)")?\](.*)$/.exec(line);
      if (!header) throw new Error('Invalid Git config section');
      section = header[1]!.toLowerCase();
      if (header[2] !== undefined) section += `.${header[2].replace(/\\(.)/g, '$1')}`;
      line = header[3]!.trim();
      if (!line) continue;
    }
    const setting = /^([a-z][a-z0-9-]*)(?:[ \t]*=[ \t]*(.*))?$/i.exec(line);
    if (!section || !setting) throw new Error('Invalid Git config setting');
    const name = `${section}.${setting[1]!.toLowerCase()}`;
    // Includes can replace the origin. Require an explicit key instead of guessing from a partial config.
    if (
      name === 'include.path' ||
      (section.startsWith('includeif.') && setting[1]!.toLowerCase() === 'path')
    ) {
      throw new Error('Git config includes require an explicit snapshot key');
    }
    const value = setting[2] === undefined ? 'true' : configValue(setting[2]);
    config.set(name, [...(config.get(name) ?? []), value]);
  }
  return config;
}

/** Comments and continuations depend on quoting, so splitting at '#' or newlines alone loses URLs. */
function configLines(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  let quoted = false;
  let comment = false;
  text = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\n') {
      if (quoted) throw new Error('Unterminated Git config quote');
      lines.push(line);
      line = '';
      comment = false;
    } else if (!comment) {
      if (char === '\\') {
        const next = text[++i];
        if (next === undefined) throw new Error('Incomplete Git config escape');
        if (next !== '\n') line += char + next;
      } else if (!quoted && (char === '#' || char === ';')) {
        comment = true;
      } else {
        if (char === '"') quoted = !quoted;
        line += char;
      }
    }
  }
  if (quoted) throw new Error('Unterminated Git config quote');
  lines.push(line);
  return lines;
}

function configValue(raw: string): string {
  const escapes: Record<string, string> = { n: '\n', t: '\t', b: '\b', '\\': '\\', '"': '"' };
  let value = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '\\') {
      const escaped = escapes[raw[++i]!];
      if (escaped === undefined) throw new Error('Invalid Git config escape');
      value += escaped;
    } else if (char !== '"') {
      value += char;
    }
  }
  return value;
}

function repositoryIdentity(remote: string): string | undefined {
  let host: string;
  let repo: string;
  if (remote.includes('://')) {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    host = url.host.toLowerCase();
    repo = url.pathname;
  } else {
    const scp = /^(?:[^/@:\s]+@)?([^/:\s]+):(.+)$/.exec(remote);
    if (!scp || /^[A-Za-z]:[\\/]/.test(remote)) return undefined;
    host = scp[1]!.toLowerCase();
    repo = scp[2]!;
  }
  repo = repo.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!repo || repo.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
  // GitHub repository names are case-insensitive; other hosts may preserve case.
  if (host === 'github.com') repo = repo.toLowerCase();
  return `${host}/${repo}`;
}
