import { Args } from '@oclif/core';
import { BaseCommand } from '../base-command';
import { CONFIG_KEYS, writeConfig } from '../lib/config';

const setApiKeyFlags = {
  quiet: BaseCommand.baseFlags.quiet,
};

export default class SetApiKey extends BaseCommand {
  static summary = 'Set the stored Limrun API key';
  static description = 'Store an API key locally, equivalent to completing `lim login` manually.';
  static examples = ['<%= config.bin %> set-api-key lim_...'];
  static flags = setApiKeyFlags;
  static args = {
    apiKey: Args.string({
      description: 'API key to store for future CLI commands.',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetApiKey);
    this.setParsedFlags(flags);
    const apiKey = args.apiKey.trim();
    if (!apiKey) {
      this.error('API key cannot be empty.');
    }
    writeConfig({ [CONFIG_KEYS.apiKey]: apiKey });
    this.info('API key saved.');
  }
}
