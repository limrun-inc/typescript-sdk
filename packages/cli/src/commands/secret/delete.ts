import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { secretTarget } from '../../lib/secret-input';

export default class SecretDelete extends BaseCommand {
  static summary = 'Delete a secret and all its values';
  static description = 'Permanently deletes the secret container and all stored versions.';
  static args = { target: Args.string({ required: true, description: 'Secret ID or exact name' }) };
  static flags = { ...BaseCommand.readOnlyFlags };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(SecretDelete);
    this.setParsedFlags(flags);
    const target = secretTarget(args.target);
    await this.withAuth(async () => {
      await this.client.secrets.delete(target);
      this.outputResult({ ok: true, target }, `Deleted secret ${target}.`);
    });
  }
}
