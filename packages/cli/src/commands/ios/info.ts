import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

type DeviceInfo = {
  udid: string;
  screenWidth: number;
  screenHeight: number;
  model: string;
};

export default class IosInfo extends BaseCommand {
  static summary = 'Get device information from a running iOS instance';
  static description =
    'Show basic simulator metadata for a running iOS instance, including UDID, model, and screen dimensions. This is useful when building coordinate-based automation or debugging device-specific behavior.';
  static examples = [
    '<%= config.bin %> ios info',
    '<%= config.bin %> ios info --id <instance-ID>',
    '<%= config.bin %> ios info --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to inspect. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosInfo);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('info is only supported on iOS instances');
      }

      let info: DeviceInfo;
      if (hasActiveSession(id)) {
        info = (await sendSessionCommand(id, 'device-info')) as DeviceInfo;
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'ios') {
            this.error('info is only supported on iOS instances');
          }
          info = (client as unknown as { deviceInfo: DeviceInfo }).deviceInfo;
        } finally {
          disconnect();
        }
      }

      if (flags.json) {
        this.outputJson(info);
      } else {
        this.outputTable(
          ['Field', 'Value'],
          [
            ['UDID', info.udid],
            ['Model', info.model],
            ['Screen Width', String(info.screenWidth)],
            ['Screen Height', String(info.screenHeight)],
          ],
        );
      }
    });
  }
}
