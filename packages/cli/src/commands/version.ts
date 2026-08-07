import { Command } from '@oclif/core';

export default class Version extends Command {
  static summary = 'Show the CLI version';
  static description = 'Display the same version information as the --version flag.';
  static examples = ['<%= config.bin %> version'];

  async run(): Promise<void> {
    this.log(this.config.userAgent);
  }
}
