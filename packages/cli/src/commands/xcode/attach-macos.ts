import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { registerCreatedInstance } from '../../lib/config';

export default class XcodeAttachMacos extends BaseCommand {
  static summary = 'Attach a macOS instance to an Xcode instance';
  static description =
    'Attach an existing macOS instance to an Xcode sandbox. Builds for --sdk macosx then install and launch ' +
    'on it, sending only what changed since the previous install, and builds default to macosx while no ' +
    'simulator is attached. When the macOS instance is omitted, the last one created here is attached.';

  static examples = [
    '<%= config.bin %> xcode attach-macos',
    '<%= config.bin %> xcode attach-macos <macOS-instance-ID>',
    '<%= config.bin %> xcode attach-macos <macOS-instance-ID> --id <xcode-instance-ID>',
  ];

  static args = {
    macosId: Args.string({
      description: 'macOS instance ID to attach. Defaults to the last macOS instance created here.',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description: 'Xcode instance ID to attach to. Defaults to the most recently created Xcode target.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeAttachMacos);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      // Resolved before the Xcode target, whose resolution may pin a replacement instance ID.
      const macos = this.resolveMacosTarget(args.macosId);
      const xcodeTarget = await this.resolveXcodeTarget(flags.id);
      const xcodeClient = await this.resolveXcodeClient(xcodeTarget);

      // The attach is a call to the Xcode instance carrying the macOS instance's apiUrl and
      // token. Only fetch from the management API when those are not already known locally.
      let attachInput: Parameters<typeof xcodeClient.attachMacOS>[0];
      if (macos.apiUrl && macos.token) {
        attachInput = { apiUrl: macos.apiUrl, token: macos.token };
      } else {
        const instance = await this.client.macosInstances.get(macos.id);
        registerCreatedInstance(instance);
        attachInput = instance;
      }

      this.info(`Attaching macOS instance ${macos.id} to Xcode target ${xcodeTarget.id}...`);
      const result = await xcodeClient.attachMacOS(attachInput);

      if (flags.json) {
        this.outputJson({ xcodeInstanceId: xcodeTarget.id, macosInstanceId: macos.id, ...result });
      } else if (this.isQuietEnabled()) {
        this.output(macos.id);
      } else {
        this.output(
          `Attached macOS instance ${macos.id} to Xcode target ${xcodeTarget.id}; ` +
            'builds for --sdk macosx now install and launch on it.',
        );
      }
    });
  }
}
