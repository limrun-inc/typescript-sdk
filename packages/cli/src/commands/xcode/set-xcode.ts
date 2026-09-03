import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { formatXcode, parseXcodeMajor } from '../../lib/xcode-version';

export default class XcodeSetXcode extends BaseCommand {
  static summary = 'Bind an Xcode instance to an installed Xcode major';
  static description =
    'Switch the Xcode a sandbox builds with, e.g. 27 for the latest beta. The sandbox must be idle: a running build, ' +
    'command, sync, or remote build execution stack refuses the switch. Switching resets the DerivedData of every ' +
    'synced project. `lim xcode list-xcode` shows the available versions and the current binding.';

  static examples = [
    '<%= config.bin %> xcode set-xcode 27',
    '<%= config.bin %> xcode set-xcode 26 --id <xcode-instance-ID>',
  ];

  static args = {
    major: Args.string({ description: 'Xcode major to bind, e.g. 27.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description: 'Xcode instance ID to switch. Defaults to the most recently created Xcode-capable target.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeSetXcode);
    this.setParsedFlags(flags);
    const major = parseXcodeMajor(args.major);

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const xcodeClient = await this.resolveXcodeClient(target);
      const result = await this.selectXcode(xcodeClient, major);
      if (flags.json) {
        this.outputJson({ instanceId: target.id, ...result });
        return;
      }
      const verb = result.alreadyBound ? 'already uses' : 'now uses';
      this.output(`Sandbox ${target.id} ${verb} Xcode ${formatXcode(result.bound)}`);
      if (result.derivedDataReset) {
        this.output('DerivedData was reset; the next build starts cold.');
      }
    });
  }
}
