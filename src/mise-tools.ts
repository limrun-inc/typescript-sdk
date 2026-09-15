import fs from 'fs/promises';
import path from 'path';
import { parse, stringify, type TomlTable } from 'smol-toml';

export function parseToolRequests(requests: string[]): Record<string, string> {
  const tools: Record<string, string> = {};
  for (const request of requests) {
    const at = request.lastIndexOf('@');
    if (at <= 0 || !request.slice(at + 1).trim())
      throw new Error(`Expected tool@version, received ${JSON.stringify(request)}.`);
    const name = request.slice(0, at);
    if (!/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(name))
      throw new Error(`Invalid tool name ${JSON.stringify(name)}.`);
    tools[name] = request.slice(at + 1);
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

/** Save requested tool versions in the project configuration. */
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
  config['tools'] = { ...(existing as TomlTable | undefined), ...tools };
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
