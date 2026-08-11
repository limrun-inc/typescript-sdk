import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidStopMicrophonePlayback extends BaseCommand {
  static summary = 'Stop mocked microphone playback on a running Android instance';
  static description =
    'Stops audio started with `android play-on-microphone`; the microphone goes back to silence (or the live WebRTC microphone when one is attached).';

  static examples = [
    '<%= config.bin %> android stop-microphone-playback',
    '<%= config.bin %> android stop-microphone-playback --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidStopMicrophonePlayback);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
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
