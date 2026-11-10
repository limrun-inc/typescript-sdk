import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { secretBytes, secretTarget } from '../../lib/secret-input';

export default class SecretWrite extends BaseCommand {
  static summary = 'Write a secret value directly to Google';
  static description =
    'Adds a new version to an existing secret. Takes VALUE as an argument by default. Use --file PATH or --stdin to read exact bytes without trimming newlines. Values never pass through Limrun APIs. Requires secret write permission.';
  static args = {
    target: Args.string({ required: true, description: 'Secret ID or exact name' }),
    value: Args.string({ description: 'Value to save; alternatively use --file or --stdin' }),
  };
  static flags = {
    ...BaseCommand.readOnlyFlags,
    file: Flags.string({ description: 'Read value from a file; use - for stdin', exclusive: ['stdin'] }),
    stdin: Flags.boolean({ description: 'Read the value from stdin', exclusive: ['file'] }),
  };
  static examples = [
    '<%= config.bin %> secret write npm/token "$NPM_TOKEN"',
    '<%= config.bin %> secret write npm/token --file ./npm-token',
    'printf %s "$NPM_TOKEN" | <%= config.bin %> secret write npm/token --stdin',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretWrite);
    this.setParsedFlags(flags);
    const target = secretTarget(args.target);
    const sources =
      Number(args.value !== undefined) + Number(flags.file !== undefined) + Number(Boolean(flags.stdin));
    if (sources !== 1) this.error('Provide VALUE, --file PATH, or --stdin, exactly one.');
    const bytes =
      args.value !== undefined ?
        Buffer.from(args.value, 'utf8')
      : await secretBytes(flags.stdin ? '-' : flags.file);
    try {
      await this.withAuth(async () => {
        await this.client.secrets.write(target, bytes);
        this.outputResult({ ok: true, target }, `Saved secret ${target}.`);
      });
    } finally {
      bytes.fill(0);
    }
  }
}
