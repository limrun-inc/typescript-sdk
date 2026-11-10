import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { secretMetadata } from '../../lib/secret-input';

export default class SecretCreate extends BaseCommand {
  static summary = 'Create a secret container';
  static description =
    'Creates metadata only. Use secret write to save the value directly in Google Secret Manager. Existing names return a conflict.';
  static args = { name: Args.string({ required: true, description: 'Exact name, such as npm/token' }) };
  static flags = {
    ...BaseCommand.readOnlyFlags,
    type: Flags.string({ default: 'generic', description: 'Payload type; descriptive only' }),
    metadata: Flags.string({
      default: '{}',
      description: 'Non-sensitive JSON object stored by Limrun; never include credentials',
    }),
  };
  static examples = [
    '<%= config.bin %> secret create npm/token --type generic --metadata \'{"registry":"npm"}\'',
  ];
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretCreate);
    this.setParsedFlags(flags);
    const metadata = secretMetadata(flags.metadata);
    await this.withAuth(async () => {
      const secret = await this.client.secrets.create({ name: args.name, type: flags.type, metadata });
      this.outputResult(
        secret,
        `Created secret ${secret.name} (${secret.id}). Use lim secret write to save its value.`,
      );
    });
  }
}
