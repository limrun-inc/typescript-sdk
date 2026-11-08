import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeDetachSimulator extends BaseCommand {
  static summary = 'Detach the attached simulator from an Xcode sandbox';
  static description =
    'Stops automatic installation on the attached simulator. Both instances, installed apps, and retained builds remain available. Repeated detach requests succeed.';
  static examples = ['<%= config.bin %> xcode detach-simulator --id <xcode-instance-ID>'];
  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description: 'Xcode sandbox ID. Defaults to the environment-pinned or last used Xcode sandbox.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeDetachSimulator);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const client = await this.resolveXcodeClient(target);
      const result = await client.detachSimulator();
      this.outputResult(result, `Detached simulator from ${target.id}.`);
    });
  }
}
