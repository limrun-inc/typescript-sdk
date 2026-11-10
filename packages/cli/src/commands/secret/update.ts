import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { secretMetadata, secretTarget } from '../../lib/secret-input';

export default class SecretUpdate extends BaseCommand {
  static summary = 'Replace descriptive secret metadata';
  static description =
    'Requires secret update permission. Does not change the name, type, or secret value. Metadata is stored by Limrun and must not contain credentials.';
  static args = { target: Args.string({ required: true, description: 'Secret ID or exact name' }) };
  static flags = {
    ...BaseCommand.readOnlyFlags,
    metadata: Flags.string({ required: true, description: 'Replacement JSON object; use {} to clear' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretUpdate);
    this.setParsedFlags(flags);
    const target = secretTarget(args.target);
    const metadata = secretMetadata(flags.metadata);
    await this.withAuth(async () => {
      const result = await this.client.secrets.update(target, { metadata });
      this.outputResult(result, `Updated metadata for ${result.name}.`);
    });
  }
}
