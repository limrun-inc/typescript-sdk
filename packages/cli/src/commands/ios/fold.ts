import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosFold extends BaseCommand {
  static summary = 'Set the native iPhone Duo hinge angle';
  static description =
    'Set an angle from 0 degrees (closed) to 180 degrees (flat). Requires an iPhone Duo instance.';
  static examples = [
    '<%= config.bin %> ios fold 90 --id <instance-ID>',
    '<%= config.bin %> ios fold 180 --json',
  ];
  static args = {
    angle: Args.string({ required: true, description: 'Hinge angle in degrees, from 0 through 180.' }),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'iOS instance ID. Defaults to the last created iOS instance.' }),
  };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosFold);
    this.setParsedFlags(flags);
    const degrees = Number(args.angle);
    if (!Number.isFinite(degrees) || degrees < 0 || degrees > 180)
      this.error('Hinge angle must be between 0 and 180 degrees');
    await this.withAuth(async () => {
      const { client, disconnect } = await getIosInstanceClient(
        this.client,
        this.resolveIosInstance(flags.id),
      );
      try {
        const state = await client.setHingeAngle(degrees);
        if (flags.json) this.outputJson(state);
        else this.log(`Hinge set to ${state.angleDegrees} degrees`);
      } finally {
        disconnect();
      }
    });
  }
}
