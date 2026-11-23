import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosKeychainReset extends BaseCommand {
  static summary = 'Wipe the keychain of a running iOS instance';
  static description =
    'Delete every keychain item, such as saved logins and tokens apps keep across reinstalls. CA certificates added with `lim ios ca add` stay trusted. To keep a copy first, run `lim ios keychain save`.';
  static examples = [
    '<%= config.bin %> ios keychain reset',
    '<%= config.bin %> ios keychain reset --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosKeychainReset);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.resetKeychain();
      } finally {
        disconnect();
      }
      this.outputResult({ ok: true, instanceId: resolvedInstance.id }, 'Keychain reset');
    });
  }
}
