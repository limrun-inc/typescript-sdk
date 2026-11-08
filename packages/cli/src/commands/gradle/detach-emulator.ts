import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';

export default class GradleDetachEmulator extends BaseCommand {
  static summary = 'Detach the attached emulator from a Gradle sandbox';
  static description =
    'Stops automatic installation on the attached emulator. Both instances, installed apps, and retained builds remain available. Repeated detach requests succeed.';
  static examples = ['<%= config.bin %> gradle detach-emulator --id <gradle-instance-ID>'];
  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description: 'Gradle sandbox ID. Defaults to the environment-pinned or last used Gradle sandbox.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GradleDetachEmulator);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const target = this.resolveGradleTarget(flags.id);
      const client = await this.resolveGradleClient(target);
      const result = await client.detachEmulator();
      this.outputResult(result, `Detached emulator from ${target.id}.`);
    });
  }
}
