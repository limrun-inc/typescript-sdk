import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { registerCreatedInstance } from '../../lib/config';

export default class GradleAttachEmulator extends BaseCommand {
  static summary = 'Attach an Android emulator and auto-install Gradle builds';
  static description =
    'Installs the latest retained APK and future APK builds on the emulator. Install failures are warnings; builds and artifact uploads continue.';
  static args = {
    emulatorId: Args.string({
      description: 'Android instance ID. Defaults to the last used emulator.',
      required: false,
    }),
  };
  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Gradle instance ID. Defaults to the last used Gradle sandbox.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleAttachEmulator);
    this.setParsedFlags(flags);
    await this.withAuth(async () => {
      const target = this.resolveGradleTarget(flags.id);
      const emulator = this.resolveAndroidInstance(args.emulatorId);
      const client = await this.resolveGradleClient(target);
      let attachment: Parameters<typeof client.attachEmulator>[0];
      if (emulator.apiUrl && emulator.token) {
        attachment = { apiUrl: emulator.apiUrl, token: emulator.token };
      } else {
        const instance = await this.client.androidInstances.get(emulator.id);
        registerCreatedInstance(instance);
        attachment = instance;
      }
      const result = await client.attachEmulator(attachment);
      if (flags.json) this.outputJson(result);
      else {
        this.output(`Attached ${emulator.id} to ${target.id}.`);
        if (result.installError) this.warn(result.installError);
        else if (result.installedLastBuild) this.output('Installed the latest APK.');
      }
    });
  }
}
