import { Args, Flags } from '@oclif/core';
import type { DeviceOrientation } from '@limrun/api/ios-client';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

const ORIENTATIONS: Record<string, DeviceOrientation> = {
  portrait: 'Portrait',
  'portrait-upside-down': 'PortraitUpsideDown',
  'landscape-left': 'LandscapeLeft',
  'landscape-right': 'LandscapeRight',
};

export default class IosSetOrientation extends BaseCommand {
  static summary = 'Rotate a running iOS instance';
  static description =
    'Turn the device to an orientation. The orientations are the ones `lim ios info` reports, written in kebab case. For an iPhone Duo, use `lim ios fold --orientation`.';
  static examples = [
    '<%= config.bin %> ios set-orientation landscape-right',
    '<%= config.bin %> ios set-orientation portrait-upside-down --id <instance-ID>',
  ];

  static args = {
    orientation: Args.string({
      description: 'Orientation to turn to.',
      required: true,
      options: Object.keys(ORIENTATIONS),
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosSetOrientation);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.setOrientation(ORIENTATIONS[args.orientation]!);
      } finally {
        disconnect();
      }
      this.outputResult(
        { ok: true, instanceId: resolvedInstance.id, orientation: args.orientation },
        `Orientation set to ${args.orientation}`,
      );
    });
  }
}
