import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecRecord extends BaseCommand {
  static summary = 'Start or stop video recording on a running instance';
  static aliases = ['ios record', 'android record'];
  static examples = [
    '<%= config.bin %> ios record start',
    '<%= config.bin %> ios record stop',
    '<%= config.bin %> ios record stop -o recording.mp4 --id <instance-ID>',
    '<%= config.bin %> ios record stop --presigned-url https://example.com/upload --id <instance-ID>',
    '<%= config.bin %> ios record start --quality 8',
    '<%= config.bin %> android record stop --id <instance-ID>',
    '<%= config.bin %> android record stop --presigned-url https://example.com/upload --id <instance-ID>',
  ];

  static args = {
    action: Args.string({ description: 'start or stop', required: true, options: ['start', 'stop'] }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Instance ID (defaults to last created)' }),
    quality: Flags.integer({ description: 'Recording quality (5-10)', default: 5 }),
    output: Flags.string({ char: 'o', description: 'Save recording to file (for stop action)' }),
    'presigned-url': Flags.string({ description: 'Upload the recording directly using this presigned URL' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecRecord);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (args.action === 'start') {
        if (hasActiveSession(id)) {
          await sendSessionCommand(id, 'start-recording', [flags.quality]);
        } else {
          const { client, disconnect } = await getInstanceClient(this.client, id);
          try {
            await (client as any).startRecording({ quality: flags.quality });
          } finally {
            disconnect();
          }
        }
        this.log('Recording started');
      } else {
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
        } else {
          const { client, disconnect } = await getInstanceClient(this.client, id);
          try {
            await (client as any).stopRecording(saveTo);
            this.log(`Recording saved to ${outputPath}`);
            if (flags['presigned-url']) {
              this.log('Recording uploaded using the provided presigned URL');
            }
          } finally {
            disconnect();
          }
        }
      }
    });
  }

  private defaultRecordingPath(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(process.cwd(), `video_${timestamp}.mp4`);
  }
}
