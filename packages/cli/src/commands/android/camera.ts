import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getAndroidInstanceClient } from '../../lib/instance-client-factory';

export default class AndroidCamera extends BaseCommand {
  static summary = 'Control the virtual camera of a running Android instance';
  static description =
    'Upload a local video file and play it as the camera feed of a running Android instance, replacing the live browser camera. ' +
    'Apps see the video through their regular Camera2/CameraX pipeline, and the file\'s audio track (if any) plays through the microphone in sync. ' +
    'By default the video loops; with --no-loop it plays once and the feed freezes on the last frame. ' +
    'Use the `clear` action to restore the default camera source.';
  static examples = [
    '<%= config.bin %> android camera play ./fixtures/qr-scan.mp4',
    '<%= config.bin %> android camera play ./clip.mp4 --no-loop --id <instance-ID>',
    '<%= config.bin %> android camera clear',
  ];

  static args = {
    action: Args.string({
      description:
        'Camera action: `play` plays a video file as the camera and `clear` restores the default camera',
      required: true,
      options: ['play', 'clear'],
    }),
    path: Args.string({
      description: 'Local video file to play as the camera (required for the `play` action).',
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    loop: Flags.boolean({
      description: 'Restart the video when it ends. Use --no-loop to play once and freeze on the last frame.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidCamera);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);

      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        if (args.action === 'clear') {
          await client.clearCameraVideo();
          if (flags.json) {
            this.outputJson({ ok: true });
          } else {
            this.output('Camera restored to the default source.');
          }
          return;
        }

        if (!args.path) {
          this.error('The `play` action requires a video file path.');
        }
        const localPath = path.resolve(args.path);
        if (!fs.existsSync(localPath)) {
          this.error(`File not found: ${localPath}`);
        }

        await client.setCameraVideo(localPath, { loop: flags.loop });
        if (flags.json) {
          this.outputJson({ ok: true, loop: flags.loop });
        } else {
          this.output(`Playing ${localPath} as the camera${flags.loop ? ' on loop' : ' once'}.`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
