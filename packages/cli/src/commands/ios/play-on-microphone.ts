import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosPlayOnMicrophone extends BaseCommand {
  static summary = 'Play a local audio file as microphone input on a running iOS instance';
  static description =
    'Upload a local audio file (WAV/MP3/M4A/AAC) to the simulator, then play it as mocked microphone input. ' +
    'Loops until stopped by default; use --once to play a single pass. Use `ios stop-microphone-playback` to stop.';

  static examples = [
    '<%= config.bin %> ios play-on-microphone ./sample.wav',
    '<%= config.bin %> ios play-on-microphone ./sample.mp3 --once',
    '<%= config.bin %> ios play-on-microphone ./sample.wav --id <instance-ID>',
  ];

  static args = {
    path: Args.string({
      description: 'Local audio file path to upload and play as microphone input',
      required: true,
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
    const { args, flags } = await this.parse(IosPlayOnMicrophone);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const localPath = path.resolve(args.path);
      if (!fs.existsSync(localPath)) {
        this.error(`File not found: ${localPath}`);
      }
      const stat = fs.statSync(localPath);
      if (!stat.isFile()) {
        this.error(`Path is not a file: ${localPath}`);
      }

      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
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
