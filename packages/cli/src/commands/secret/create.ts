import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { secretBytes, secretMetadata } from '../../lib/secret-input';

export default class SecretCreate extends BaseCommand {
  static summary = 'Create a secret, optionally with a value';
  static description =
    'Creates a secret container. Optionally takes VALUE, --file PATH, or --stdin to save its initial value directly in Google Secret Manager. Without a value, creates metadata only. Existing names return a conflict. Saving a value also requires secret write permission.';
  static args = {
    name: Args.string({ ignoreStdin: true, required: true, description: 'Exact name, such as npm/token' }),
    value: Args.string({
      ignoreStdin: true,
      description: 'Initial value; alternatively use --file or --stdin',
    }),
  };
  static flags = {
    ...BaseCommand.readOnlyFlags,
    file: Flags.string({ description: 'Read value from a file; use - for stdin', exclusive: ['stdin'] }),
    stdin: Flags.boolean({ description: 'Read the value from stdin', exclusive: ['file'] }),
    type: Flags.string({ default: 'generic', description: 'Payload type; descriptive only' }),
    metadata: Flags.string({
      default: '{}',
      description: 'Non-sensitive JSON object stored by Limrun; never include credentials',
    }),
  };
  static examples = [
    '<%= config.bin %> secret create npm/token --type generic --metadata \'{"registry":"npm"}\'',
    '<%= config.bin %> secret create npm/token "$NPM_TOKEN"',
    '<%= config.bin %> secret create npm/config --file .npmrc',
    'printf %s "$NPM_TOKEN" | <%= config.bin %> secret create npm/token --stdin',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretCreate);
    this.setParsedFlags(flags);
    const metadata = secretMetadata(flags.metadata);
    const sources =
      Number(args.value !== undefined) + Number(flags.file !== undefined) + Number(Boolean(flags.stdin));
    if (sources > 1) this.error('Provide at most one of VALUE, --file PATH, or --stdin.');
    const bytes =
      args.value !== undefined ? Buffer.from(args.value, 'utf8')
      : sources ? await secretBytes(flags.stdin ? '-' : flags.file)
      : undefined;
    try {
      if (bytes && (!bytes.length || bytes.length > 65536))
        this.error('Secret values must contain between 1 byte and 64 KiB.');
      const secret = await this.withAuth(() =>
        this.client.secrets.create({ name: args.name, type: flags.type, metadata }),
      );
      if (bytes) {
        try {
          // Keep authentication retries from creating the container twice.
          await this.withAuth(() => this.client.secrets.write(secret.id, bytes));
        } catch {
          this.error(
            `Created secret ${secret.name} (${secret.id}), but saving its value failed. You can retry with lim secret write ${secret.id} --stdin using a credential with secret write permission.`,
          );
        }
      }
      this.outputResult(
        secret,
        bytes ?
          `Created secret ${secret.name} (${secret.id}) and saved its value.`
        : `Created secret ${secret.name} (${secret.id}). Use lim secret write to save its value.`,
      );
    } finally {
      bytes?.fill(0);
    }
  }
}
