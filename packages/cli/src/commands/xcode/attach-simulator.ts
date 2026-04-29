import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class XcodeAttachSimulator extends BaseCommand {
  static summary = 'Attach an iOS simulator to an Xcode instance';
  static description =
    'Attach an existing iOS simulator to an Xcode sandbox so future builds can auto-install on that simulator.';

  static examples = [
    '<%= config.bin %> xcode attach-simulator <ios-instance-ID>',
    '<%= config.bin %> xcode attach-simulator <ios-instance-ID> --id <xcode-instance-ID>',
  ];

  static args = {
    simulatorId: Args.string({
      description: 'iOS simulator instance ID to attach',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({
      hidden: true,
      default: false,
      allowNo: true,
    }),
    id: Flags.string({
      description:
        'Xcode instance ID to attach to, or an iOS instance ID with `--xcode` enabled. Defaults to the most recently created Xcode-capable target.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeAttachSimulator);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const xcodeInstanceId = this.resolveId(flags.id);
      const simulator = await this.client.iosInstances.get(args.simulatorId);
      const xcodeClient = await this.resolveXcodeClient(xcodeInstanceId);

      this.info(`Attaching simulator ${args.simulatorId} to Xcode target ${xcodeInstanceId}...`);
      await xcodeClient.attachSimulator(simulator);

      if (flags.json) {
        this.outputJson({
          xcodeInstanceId,
          simulatorInstanceId: simulator.metadata.id,
        });
      } else if (this.isQuietEnabled()) {
        this.output(simulator.metadata.id);
      } else {
        this.output(`Attached simulator ${simulator.metadata.id} to Xcode target ${xcodeInstanceId}`);
      }
    });
  }
}
