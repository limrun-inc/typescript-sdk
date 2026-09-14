#!/usr/bin/env node
// Copy the server's compatibility contract into the SDK without a runtime repository dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = process.argv[2];
if (!checkout || checkout.startsWith('--')) {
  throw new Error('Usage: node scripts/sync-mise-policy.mjs <limrun-checkout> [--check]');
}
const source = path.resolve(checkout, 'pkg/build/mise');
const policy = JSON.parse(await fs.readFile(path.join(source, 'policy.json'), 'utf8'));
const cases = JSON.parse(await fs.readFile(path.join(source, 'testdata/compatibility.json'), 'utf8'));
const outputs = {
  'src/internal/mise-policy.ts':
    '// Generated from limrun/pkg/build/mise/policy.json by scripts/sync-mise-policy.mjs.\n' +
    `export const misePolicy = ${JSON.stringify(policy, null, 2)};\n`,
  'tests/fixtures/mise-compatibility.json': JSON.stringify(cases, null, 2) + '\n',
};
// Match repository formatting so --check also works after scripts/format.
const prettier = await import('prettier');
for (const [relative, content] of Object.entries(outputs)) {
  const destination = path.join(root, relative);
  const formatted = await prettier.format(content, {
    ...(await prettier.resolveConfig(destination)),
    filepath: destination,
  });
  if (process.argv.includes('--check')) {
    if ((await fs.readFile(destination, 'utf8')) !== formatted) {
      throw new Error(`${relative} differs from the server contract; run this command without --check`);
    }
  } else {
    await fs.writeFile(destination, formatted);
  }
}
