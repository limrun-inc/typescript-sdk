import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosStopMicrophonePlayback extends BaseCommand {
  static summary = 'Stop mocked microphone playback on a running iOS instance';
  static description =
    'Stops audio started with `ios play-on-microphone`; the microphone goes back to silence.';

  static examples = [
    '<%= config.bin %> ios stop-microphone-playback',
    '<%= config.bin %> ios stop-microphone-playback --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosStopMicrophonePlayback);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.stopMicrophonePlayback();
        if (flags.json) {
          this.outputJson({ stopped: true });
        } else {
          this.output('Stopped microphone playback');
        }
      } finally {
        disconnect();
      }
    });
  }
}
