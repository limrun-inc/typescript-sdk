import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeDetachMacos extends BaseCommand {
  static summary = 'Detach the attached macOS instance from an Xcode sandbox';
  static description =
    'Stops automatic installation on the attached macOS instance. Both instances and installed apps remain available. Repeated detach requests succeed.';
  static examples = ['<%= config.bin %> xcode detach-macos --id <xcode-instance-ID>'];
  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description: 'Xcode sandbox ID. Defaults to the environment-pinned or last used Xcode sandbox.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeDetachMacos);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const client = await this.resolveXcodeClient(target);
      const result = await client.detachMacOS();
      this.outputResult(result, `Detached macOS instance from ${target.id}.`);
    });
  }
}
