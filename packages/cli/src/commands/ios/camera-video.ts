import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

export default class IosCameraVideo extends BaseCommand {
  static summary = 'Play a video file as the simulated camera';
  static description =
    'Upload a local video file and play it as the camera feed of a running iOS instance, replacing the live browser camera. ' +
    'Apps see the video through their regular AVCaptureSession pipeline. ' +
    'By default the video loops; with --no-loop it plays once and the feed freezes on the last frame. ' +
    'Use the `clear` action to restore the default camera source.';
  static examples = [
    '<%= config.bin %> ios camera-video play ./fixtures/qr-scan.mp4',
    '<%= config.bin %> ios camera-video play ./clip.mp4 --no-loop --id <instance-ID>',
    '<%= config.bin %> ios camera-video clear',
  ];

  static args = {
    action: Args.string({
      description: 'Camera video action: `play` starts playback and `clear` restores the default camera',
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
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    loop: Flags.boolean({
      description: 'Restart the video when it ends. Use --no-loop to play once and freeze on the last frame.',
      default: true,
      allowNo: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosCameraVideo);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
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
