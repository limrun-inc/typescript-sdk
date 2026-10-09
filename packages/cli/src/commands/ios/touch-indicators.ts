import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosTouchIndicators extends BaseCommand {
  static summary = 'Show or hide touch ripples and drag trails on an iOS instance';
  static description =
    'Touch indicators visualize input with translucent circles that expand where you touch ' +
    'and trails that trace your finger during drags. They are enabled by default on iPhone and iPad simulators. ' +
    'This setting affects all live viewers, screenshots, and recordings. ' +
    'It remains set across client reconnects and recording start/stop; a new simulator boot enables it again.';
  static examples = [
    '<%= config.bin %> ios touch-indicators off',
    '<%= config.bin %> ios touch-indicators on --id <instance-ID>',
  ];

  static args = {
    state: Args.string({
      description: 'Whether to show touch indicators.',
      required: true,
      options: ['on', 'off'],
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosTouchIndicators);
    this.setParsedFlags(flags);
    const enabled = args.state === 'on';

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      if (await ensureDaemonSession(resolvedInstance)) {
        await sendSessionCommand(resolvedInstance.id, 'touch-indicators', [enabled]);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.setTouchIndicators(enabled);
        } finally {
          disconnect();
        }
      }
      if (flags.json) {
        this.outputJson({ enabled });
      } else {
        this.output(`Touch indicators ${enabled ? 'enabled' : 'disabled'}.`);
      }
    });
  }
}
