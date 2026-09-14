import { misePolicy } from './internal/mise-policy';
import fs from 'fs/promises';
import path from 'path';
import { parse, stringify, type TomlTable } from 'smol-toml';

const toolAliases = new Map(Object.entries(misePolicy.aliases));
const vendorPrefixes = new Map(
  Object.entries(misePolicy.vendorPrefixes).map(([name, prefixes]) => [
    name,
    new Map(Object.entries(prefixes)),
  ]),
);
const numericVersion = new RegExp(misePolicy.numericVersionPattern);

export function toolCompatibilityLine(name: string, input: string): string {
  name = canonicalToolName(name);
  let version = input.trim();
  if (version === 'latest') return version;
  let vendor = '';
  const dash = version.indexOf('-');
  const canonical = vendorPrefixes.get(name)?.get(version.slice(0, dash));
  if (dash !== -1 && canonical) {
    vendor = canonical + '-';
    version = version.slice(dash + 1);
  }
  const parts = numericVersion.exec(version);
  if (!parts)
    throw new Error(
      `${name}@${input} must name a numeric version. Use mise use through the sandbox run command for custom versions.`,
    );
  if (misePolicy.minorSensitiveTools.includes(name) || parts[1] === '0') {
    if (!parts[2]) throw new Error(`${name} requires a major.minor version.`);
    return `${vendor}${parts[1]}.${parts[2]}`;
  }
  return `${vendor}${parts[1]}`;
}

function canonicalToolName(name: string): string {
  return toolAliases.get(name) ?? name;
}

export function parseToolRequests(requests: string[]): Record<string, string> {
  const tools: Record<string, string> = {};
  for (const request of requests) {
    const at = request.lastIndexOf('@');
    if (at <= 0 || at === request.length - 1)
      throw new Error(`Expected tool@version, received ${JSON.stringify(request)}.`);
    let name = request.slice(0, at);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(name))
      throw new Error(`Invalid tool name ${JSON.stringify(name)}.`);
    name = canonicalToolName(name);
    if (misePolicy.excludedTools.includes(name))
      throw new Error(`${name} is managed separately from mise tools.`);
    tools[name] = toolCompatibilityLine(name, request.slice(at + 1));
  }
  return tools;
}

async function readConfig(file: string): Promise<TomlTable> {
  try {
    return parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read mise configuration ${file}: ${String(error)}`);
  }
}

/** Save compatibility lines without installing anything on the client. */
export async function writeMiseTools(directory: string, tools: Record<string, string>): Promise<string> {
  let file = path.join(directory, 'mise.toml');
  // Update the highest-precedence existing file in this directory.
  for (const name of ['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml']) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate);
      file = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const config = await readConfig(file);
  const existing = config['tools'];
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing)))
    throw new Error(`Expected [tools] in ${file}.`);
  const selected = { ...(existing as TomlTable | undefined), ...tools };
  for (const [alias, canonical] of Object.entries(misePolicy.aliases)) {
    if (canonical in tools) delete selected[alias];
  }
  config['tools'] = selected;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, stringify(config), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return file;
}
