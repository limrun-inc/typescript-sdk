import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosMicrophone extends BaseCommand {
  static summary = 'Control the simulated microphone of a running iOS instance';
  static description =
    'Upload a local audio file (WAV/MP3/M4A/AAC) and play it as mocked microphone input on a running iOS instance. ' +
    'Playback loops until stopped by default; use --once to play a single pass. ' +
    'Use the `stop` action to return the microphone to silence.';

  static examples = [
    '<%= config.bin %> ios microphone play ./sample.wav',
    '<%= config.bin %> ios microphone play ./sample.mp3 --once',
    '<%= config.bin %> ios microphone play ./sample.wav --id <instance-ID>',
    '<%= config.bin %> ios microphone stop',
  ];

  static args = {
    action: Args.string({
      description: 'Microphone action: `play` plays an audio file and `stop` stops mocked input',
      required: true,
      options: ['play', 'stop'],
    }),
    path: Args.string({
      description: 'Local audio file to play as microphone input (required for the `play` action)',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    once: Flags.boolean({
      description: 'Play the audio file once instead of looping it',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosMicrophone);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        if (args.action === 'stop') {
          await client.stopMicrophonePlayback();
          if (flags.json) {
            this.outputJson({ stopped: true });
          } else {
            this.output('Stopped microphone playback');
          }
          return;
        }

        if (!args.path) {
          this.error('The `play` action requires an audio file path.');
        }
        const localPath = path.resolve(args.path);
        if (!fs.existsSync(localPath)) {
          this.error(`File not found: ${localPath}`);
        }
        const stat = fs.statSync(localPath);
        if (!stat.isFile()) {
          this.error(`Path is not a file: ${localPath}`);
        }

        const remoteName = path.basename(localPath);
        this.info(`Uploading ${remoteName}...`);
        await client.pushFile(localPath, remoteName);
        const result = await client.playOnMicrophone(remoteName, { once: flags.once });

        if (flags.json) {
          this.outputJson(result);
        } else {
          this.output(
            `Playing ${remoteName} on microphone (duration=${result.duration}us, once=${result.once})`,
          );
        }
      } finally {
        disconnect();
      }
    });
  }
}
