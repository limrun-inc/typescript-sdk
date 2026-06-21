import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

const REMOTE_AUDIO_DIR = '/data/local/tmp';

export default class AndroidPlayOnMicrophone extends BaseCommand {
  static summary = 'Play a local audio file as microphone input on a running Android instance';
  static description =
    'Push a local WAV/MP3 file to the Android instance with ADB, then play it as mocked microphone input.';

  static examples = [
    '<%= config.bin %> android play-on-microphone ./sample.wav',
    '<%= config.bin %> android play-on-microphone ./sample.mp3 --once',
    '<%= config.bin %> android play-on-microphone ./sample.wav --id <instance-ID>',
  ];

  static args = {
    path: Args.string({
      description: 'Local WAV/MP3 file path to push and play as microphone input',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    once: Flags.boolean({
      description: 'Play the audio file once instead of looping it',
      default: false,
    }),
    'adb-path': Flags.string({
      description: 'Path to the adb binary available on your machine',
      default: 'adb',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidPlayOnMicrophone);
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

      const remotePath = `${REMOTE_AUDIO_DIR}/${path.basename(localPath)}`;
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance, {
        adbPath: flags['adb-path'],
      });

      let tunnel: Awaited<ReturnType<typeof client.startAdbTunnel>> | undefined;
      try {
        tunnel = await client.startAdbTunnel();
        const serial = `${tunnel.address.address}:${tunnel.address.port}`;
        this.info(`Pushing ${path.basename(localPath)} to ${remotePath}...`);
        await this.execAdb(flags['adb-path'], ['-s', serial, 'push', localPath, remotePath]);
        const result = await client.playOnMicrophone(remotePath, { once: flags.once });

        if (flags.json) {
          this.outputJson(result);
        } else {
          this.log(
            `Playing ${remotePath} on microphone (duration=${result.duration}us, once=${result.once}, generation=${result.generation})`,
          );
        }
      } finally {
        tunnel?.close();
        disconnect();
      }
    });
  }

  private execAdb(adbPath: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(adbPath, args, (error, stdout, stderr) => {
        if (error) {
          const output = `${stdout}${stderr}`.trim();
          reject(new Error(output ? `${error.message}: ${output}` : error.message));
          return;
        }
        resolve();
      });
    });
  }
}
