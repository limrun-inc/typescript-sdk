import { Args, Flags } from '@oclif/core';
import { writeFile } from 'node:fs/promises';
import { BaseCommand } from '../../base-command';
import { secretTarget } from '../../lib/secret-input';

export default class SecretRead extends BaseCommand {
  static summary = 'Read a secret value directly from Google';
  static description =
    'Writes exact bytes to stdout with no added newline, or creates a private file with --output. --json returns base64 data. Requires secret read permission; values never pass through Limrun APIs.';
  static args = { target: Args.string({ required: true, description: 'Secret ID or exact name' }) };
  static flags = {
    ...BaseCommand.readOnlyFlags,
    output: Flags.string({ description: 'Create an output file with mode 0600; refuses to overwrite' }),
  };
  static examples = [
    '<%= config.bin %> secret read npm/token',
    '<%= config.bin %> secret read npm/config --output .npmrc',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretRead);
    this.setParsedFlags(flags);
    const target = secretTarget(args.target);
    await this.withAuth(async () => {
      const bytes = await this.client.secrets.read(target);
      try {
        if (flags.output) {
          await writeFile(flags.output, bytes, { mode: 0o600, flag: 'wx' });
          this.outputResult({ ok: true, target, path: flags.output }, `Saved secret to ${flags.output}.`);
        } else if (flags.json)
          this.outputJson({ encoding: 'base64', data: Buffer.from(bytes).toString('base64') });
        else
          await new Promise<void>((resolve, reject) =>
            process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
          );
      } finally {
        bytes.fill(0);
      }
    });
  }
}
