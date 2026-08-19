import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { registerCreatedInstance } from '../../lib/config';
import { formatSimulatorAttachResult, simulatorAttachJson } from '../../lib/simulator-attach';

export default class IosAttachXcode extends BaseCommand {
  static summary = 'Attach an Xcode instance to an iOS simulator';
  static description =
    'Attach an Xcode sandbox to an existing iOS simulator so future builds can auto-install on that simulator. ' +
    'When the Xcode target is omitted, the LIM_XCODE_INSTANCE_URL/LIM_XCODE_INSTANCE_TOKEN pair or the last used ' +
    'Xcode-capable target is attached; if the simulator credentials are known locally, no API key is needed.';

  static examples = [
    '<%= config.bin %> ios attach-xcode',
    '<%= config.bin %> ios attach-xcode <xcode-instance-ID>',
    '<%= config.bin %> ios attach-xcode <xcode-instance-ID> --id <ios-instance-ID>',
  ];

  static args = {
    xcodeId: Args.string({
      description: 'Xcode target to attach. Defaults to the environment-pinned or last used Xcode target.',
      required: false,
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
      description: 'iOS simulator instance ID to attach. Defaults to the last used iOS simulator.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosAttachXcode);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const simulator = this.resolveIosInstance(flags.id);
      const xcodeTarget = await this.resolveXcodeTarget(args.xcodeId);
      const xcodeInstanceId = xcodeTarget.id;
      const xcodeClient = await this.resolveXcodeClient(xcodeTarget);

      let attachInput: Parameters<typeof xcodeClient.attachSimulator>[0];
      if (simulator.apiUrl && simulator.token) {
        attachInput = { apiUrl: simulator.apiUrl, token: simulator.token };
      } else {
        const instance = await this.client.iosInstances.get(simulator.id);
        registerCreatedInstance(instance);
        attachInput = instance;
      }

      this.info(`Attaching Xcode target ${xcodeInstanceId} to simulator ${simulator.id}...`);
      const result = await xcodeClient.attachSimulator(attachInput);

      if (flags.json) {
        this.outputJson(simulatorAttachJson(simulator.id, xcodeInstanceId, result));
      } else if (this.isQuietEnabled()) {
        this.output(xcodeInstanceId);
      } else {
        this.output(formatSimulatorAttachResult(simulator.id, xcodeInstanceId, result));
      }
    });
  }
}
