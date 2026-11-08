import { Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import { parseProvisioningProfileBytes } from '@limrun/apple-auth';
import { BaseCommand } from '../../../base-command';

export default class InspectAppleProfile extends BaseCommand {
  static summary = 'Read a local provisioning profile without signing in';
  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({ description: 'Provisioning profile file.', required: true }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(InspectAppleProfile);
    this.setParsedFlags(flags);
    this.outputJson(parseProvisioningProfileBytes(await readFile(flags.file)));
  }
}
