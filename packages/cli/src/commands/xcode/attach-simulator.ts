import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { registerCreatedInstance } from '../../lib/config';
import { formatSimulatorAttachResult, simulatorAttachJson } from '../../lib/simulator-attach';

export default class XcodeAttachSimulator extends BaseCommand {
  static summary = 'Attach an iOS simulator to an Xcode instance';
  static description =
    'Attach an existing iOS simulator to an Xcode sandbox so future builds can auto-install on that simulator. ' +
    'When the simulator is omitted, the LIM_IOS_INSTANCE_URL/LIM_IOS_INSTANCE_TOKEN pair or the last used ' +
    'simulator is attached; if its credentials are known locally, no API key is needed.';

  static examples = [
    '<%= config.bin %> xcode attach-simulator',
    '<%= config.bin %> xcode attach-simulator <ios-instance-ID>',
    '<%= config.bin %> xcode attach-simulator <ios-instance-ID> --id <xcode-instance-ID>',
  ];

  static args = {
    simulatorId: Args.string({
      description:
        'iOS simulator instance ID to attach. Defaults to the environment-pinned or last used simulator.',
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
      description:
        'Xcode instance ID to attach to, or a legacy iOS instance ID with an embedded Xcode sandbox. Defaults to the most recently created Xcode-capable target.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeAttachSimulator);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const xcodeTarget = await this.resolveXcodeTarget(flags.id);
      const xcodeInstanceId = xcodeTarget.id;
      const resolved = this.resolveIosInstance(args.simulatorId);
      const xcodeClient = await this.resolveXcodeClient(xcodeTarget);

      // The attach itself is a call to the Xcode instance carrying the
      // simulator's apiUrl and token. Only fetch from the management API
      // when those credentials are not already known locally.
      let attachInput: Parameters<typeof xcodeClient.attachSimulator>[0];
      if (resolved.apiUrl && resolved.token) {
        attachInput = { apiUrl: resolved.apiUrl, token: resolved.token };
      } else {
        const simulator = await this.client.iosInstances.get(resolved.id);
        registerCreatedInstance(simulator);
        attachInput = simulator;
      }

      this.info(`Attaching simulator ${resolved.id} to Xcode target ${xcodeInstanceId}...`);
      const result = await xcodeClient.attachSimulator(attachInput);

      if (flags.json) {
        this.outputJson(simulatorAttachJson(resolved.id, xcodeInstanceId, result));
      } else if (this.isQuietEnabled()) {
        this.output(resolved.id);
      } else {
        this.output(formatSimulatorAttachResult(resolved.id, xcodeInstanceId, result));
      }
    });
  }
}
