import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidRecord extends BaseCommand {
  static summary = 'Start or stop video recording on a running Android instance';
  static description =
    'Control screen recording on a running Android instance. Start recording first, then stop recording to download the file locally or upload it directly with `--presigned-url`.';
  static examples = [
    '<%= config.bin %> android record start',
    '<%= config.bin %> android record stop',
    '<%= config.bin %> android record stop -o recording.mp4 --id <instance-ID>',
    '<%= config.bin %> android record stop --presigned-url https://example.com/upload --id <instance-ID>',
  ];

  static args = {
    action: Args.string({
      description:
        'Recording action to perform: `start` begins capturing and `stop` finalizes the video file',
      required: true,
      options: ['start', 'stop'],
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to record. Defaults to the last created Android instance.',
    }),
    quality: Flags.integer({
      description:
        'Recording quality from 5 to 10. Higher values increase quality and file size when starting a recording.',
      default: 5,
    }),
    output: Flags.string({
      char: 'o',
      description:
        'Local file path for the finished recording when using the `stop` action. Defaults to a timestamped mp4 in the current directory.',
    }),
    'presigned-url': Flags.string({
      description:
        'Presigned upload URL to receive the recording when using the `stop` action. Use this if you will upload the recording to a bucket.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidRecord);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android record only supports Android instances');
      }

      if (args.action === 'start') {
        if (hasActiveSession(id)) {
          await sendSessionCommand(id, 'start-recording', [flags.quality]);
        } else {
          const { type, client, disconnect } = await getInstanceClient(this.client, id);
          try {
            if (type !== 'android') {
              this.error('android record only supports Android instances');
            }
            await (client as any).startRecording({ quality: flags.quality });
          } finally {
            disconnect();
          }
        }
        this.log('Recording started');
        return;
      }

      const outputPath = flags.output ? path.resolve(flags.output) : this.defaultRecordingPath();
      const saveTo = {
        localPath: outputPath,
        presignedUrl: flags['presigned-url'],
      };

      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'stop-recording', [saveTo]);
        this.log(`Recording saved to ${outputPath}`);
        if (flags['presigned-url']) {
          this.log('Recording uploaded using the provided presigned URL');
        }
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'android') {
          this.error('android record only supports Android instances');
        }
        await (client as any).stopRecording(saveTo);
        this.log(`Recording saved to ${outputPath}`);
        if (flags['presigned-url']) {
          this.log('Recording uploaded using the provided presigned URL');
        }
      } finally {
        disconnect();
      }
    });
  }

  private defaultRecordingPath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(process.cwd(), `video_${timestamp}.mp4`);
  }
}
