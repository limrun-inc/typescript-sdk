import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosToggleKeyboard extends BaseCommand {
  static summary = 'Toggle the iOS software keyboard';
  static description =
    'Show or hide the software keyboard on a running iOS instance. This is useful when the keyboard is covering UI or when you need to reopen it after dismissing it.';
  static examples = [
    '<%= config.bin %> ios toggle-keyboard',
    '<%= config.bin %> ios toggle-keyboard --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosToggleKeyboard);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios toggle-keyboard only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'toggle-keyboard');
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.toggleKeyboard();
        } finally {
          disconnect();
        }
      }

      this.log('Software keyboard toggled');
    });
  }
}
