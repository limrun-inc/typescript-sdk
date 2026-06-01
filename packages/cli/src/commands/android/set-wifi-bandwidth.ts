import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getAndroidInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidSetWifiBandwidth extends BaseCommand {
  static summary = 'Set Wi-Fi bandwidth limits on a running Android instance';
  static description =
    'Set Android Wi-Fi upload and/or download bandwidth limits in Kbps. Omit a direction to leave it unchanged; pass 0 to clear that direction.';
  static examples = [
    '<%= config.bin %> android set-wifi-bandwidth --down-kbps 1000',
    '<%= config.bin %> android set-wifi-bandwidth --up-kbps 1000 --id <instance-ID>',
    '<%= config.bin %> android set-wifi-bandwidth --up-kbps 0',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description:
        'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    'down-kbps': Flags.integer({
      description: 'Download bandwidth limit in Kbps. Use 0 to clear the download limit.',
    }),
    'up-kbps': Flags.integer({
      description: 'Upload bandwidth limit in Kbps. Use 0 to clear the upload limit.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidSetWifiBandwidth);
    this.setParsedFlags(flags);

    const bandwidth = {
      downKbps: flags['down-kbps'],
      upKbps: flags['up-kbps'],
    };

    if (bandwidth.downKbps === undefined && bandwidth.upKbps === undefined) {
      this.error('Provide --down-kbps, --up-kbps, or both.');
    }
    if (bandwidth.downKbps !== undefined) {
      this.validateKbps('down-kbps', bandwidth.downKbps);
    }
    if (bandwidth.upKbps !== undefined) {
      this.validateKbps('up-kbps', bandwidth.upKbps);
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'set-wifi-bandwidth', [bandwidth]);
      } else {
        const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
        try {
          await client.setWifiBandwidth(bandwidth);
        } finally {
          disconnect();
        }
      }

      this.log(this.formatResult(bandwidth));
    });
  }

  private validateKbps(flagName: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      this.error(`--${flagName} must be a non-negative integer Kbps value.`);
    }
  }

  private formatResult(bandwidth: { downKbps?: number; upKbps?: number }): string {
    const parts: string[] = [];
    if (bandwidth.downKbps !== undefined) {
      parts.push(`download=${bandwidth.downKbps} Kbps`);
    }
    if (bandwidth.upKbps !== undefined) {
      parts.push(`upload=${bandwidth.upKbps} Kbps`);
    }
    return `Wi-Fi bandwidth updated (${parts.join(', ')})`;
  }
}
