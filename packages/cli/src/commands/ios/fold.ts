import { Args, Flags } from '@oclif/core';
import type { DuoOrientation } from '@limrun/api/ios-client';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosFold extends BaseCommand {
  static summary = 'Read or change the native iPhone Duo fold state';
  static description =
    'Read the fold state, set an angle from 0 degrees (closed) to 180 degrees (flat), or change device orientation. Requires an iPhone Duo instance.';
  static examples = [
    '<%= config.bin %> ios fold 90 --id <instance-ID>',
    '<%= config.bin %> ios fold 180 --json',
    '<%= config.bin %> ios fold --json',
    '<%= config.bin %> ios fold 90 --orientation landscape-left',
  ];
  static args = {
    angle: Args.string({ description: 'Hinge angle in degrees, from 0 through 180. Omit to read state.' }),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'iOS instance ID. Defaults to the last created iOS instance.' }),
    orientation: Flags.string({
      description: 'Native device orientation. pud means portrait upside down.',
      options: ['portrait', 'pud', 'landscape-left', 'landscape-right'],
    }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosFold);
    this.setParsedFlags(flags);
    const degrees = args.angle === undefined ? undefined : Number(args.angle);
    if (degrees !== undefined && (!Number.isFinite(degrees) || degrees < 0 || degrees > 180))
      this.error('Hinge angle must be between 0 and 180 degrees');
    await this.withAuth(async () => {
      const { client, disconnect } = await getIosInstanceClient(
        this.client,
        this.resolveIosInstance(flags.id),
      );
      try {
        let state = await client.getFoldState();
        if (!state) this.error('This simulator does not support native folding');
        if (flags.orientation) state = await client.setDuoOrientation(flags.orientation as DuoOrientation);
        if (degrees !== undefined) state = await client.setHingeAngle(degrees);
        if (flags.json) this.outputJson(state);
        else this.log(`Hinge: ${state.angleDegrees} degrees; orientation: ${state.orientation}`);
      } finally {
        disconnect();
      }
    });
  }
}
