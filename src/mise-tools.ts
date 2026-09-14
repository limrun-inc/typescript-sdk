import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parse, stringify, type TomlTable } from 'smol-toml';

/** Personal tool defaults read by build clients. Project mise files take precedence remotely. */
export function miseDefaultsFile(): string {
  return (
    process.env['MISE_GLOBAL_CONFIG_FILE'] ??
    path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'mise', 'config.toml')
  );
}

export function toolCompatibilityLine(name: string, input: string): string {
  let version = input.trim();
  if (version === 'latest') return version;
  let vendor = '';
  if (name === 'java') {
    const match = /^(jetbrains|jbr|corretto|temurin|openjdk|zulu|liberica|graalvm)-/.exec(version);
    if (match) {
      vendor = match[0];
      version = version.slice(vendor.length);
      if (vendor === 'jbr-') vendor = 'jetbrains-';
    }
  }
  const parts = /^v?([0-9]+)(?:\.([0-9]+))?(?:\.[0-9]+)*(?:[-+][A-Za-z0-9._+-]+)?$/.exec(version);
  if (!parts)
    throw new Error(
      `${name}@${input} must name a numeric version. Use mise use through the sandbox run command for custom versions.`,
    );
  if (['ruby', 'python', 'go', 'flutter', 'dart'].includes(name) || parts[1] === '0') {
    if (!parts[2]) throw new Error(`${name} requires a major.minor version.`);
    return `${vendor}${parts[1]}.${parts[2]}`;
  }
  return `${vendor}${parts[1]}`;
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
    if (name === 'nodejs') name = 'node';
    if (name === 'jdk') name = 'java';
    if (['gem:bundler', 'gem:cocoapods', 'gem:cocoapods-patch'].includes(name)) name = name.slice(4);
    if (['xcode', 'swift', 'brew', 'homebrew'].includes(name))
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

export async function readMiseDefaults(file = miseDefaultsFile()): Promise<Record<string, unknown>> {
  const config = await readConfig(file);
  const tools = config['tools'];
  if (tools === undefined) return {};
  if (!tools || typeof tools !== 'object' || Array.isArray(tools))
    throw new Error(`Expected [tools] in ${file}.`);
  // Only tool requests cross the connection. Tasks, environment and secrets stay on the client.
  return tools as Record<string, unknown>;
}

/** Save compatibility lines without installing anything on the client. */
export async function writeMiseTools(
  directory: string,
  tools: Record<string, string>,
  global = false,
): Promise<string> {
  let file = global ? miseDefaultsFile() : path.join(directory, 'mise.toml');
  if (!global) {
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
  }
  const config = await readConfig(file);
  const existing = config['tools'];
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing)))
    throw new Error(`Expected [tools] in ${file}.`);
  const selected = { ...(existing as TomlTable | undefined), ...tools };
  for (const [alias, canonical] of Object.entries({
    nodejs: 'node',
    jdk: 'java',
    'gem:bundler': 'bundler',
    'gem:cocoapods': 'cocoapods',
    'gem:cocoapods-patch': 'cocoapods-patch',
  })) {
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
