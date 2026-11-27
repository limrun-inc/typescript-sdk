import fs from 'node:fs';

// Node's process.loadEnvFile and util.parseEnv need Node 20.12, and some sandboxes ship an
// older Node 20, such as E2B's default template with 20.9. Parsing .env files here keeps
// every command working there. The rules follow Node's, so a file reads the same either way.
export function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equal = line.indexOf('=');
    if (equal < 0) continue;
    let key = line.slice(0, equal).trim();
    if (key.startsWith('export ')) key = key.slice('export '.length).trim();
    if (key === '') continue;
    const raw = line.slice(equal + 1).trim();
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // A quoted value may span lines until its closing quote.
      let body = raw.slice(1);
      let end = i;
      let close = body.indexOf(quote);
      while (close < 0 && end + 1 < lines.length) {
        end++;
        body += '\n' + lines[end];
        close = body.indexOf(quote);
      }
      if (close >= 0) {
        const value = body.slice(0, close);
        // Only double quotes turn an escaped \n into a line break.
        env[key] = quote === '"' ? value.split('\\n').join('\n') : value;
        i = end;
        continue;
      }
      // Without a closing quote, the value is the rest of the line, quote included.
      env[key] = raw;
      continue;
    }
    // An unquoted value ends at the first #, which starts a comment.
    const hash = raw.indexOf('#');
    env[key] = (hash < 0 ? raw : raw.slice(0, hash)).trim();
  }
  return env;
}

// Like Node's process.loadEnvFile, a variable the shell already set keeps its value.
export function loadEnvFile(path = '.env'): void {
  for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(path, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Load before config dependencies evaluate, preserving values supplied by the shell.
try {
  loadEnvFile(process.env['DOTENV_CONFIG_PATH']);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}
