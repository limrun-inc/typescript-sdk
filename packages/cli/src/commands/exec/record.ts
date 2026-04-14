import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecRecord extends BaseCommand {
  static summary = 'Start or stop video recording on a running instance';
  static aliases = ['ios record', 'android record'];
  static examples = [
    '<%= config.bin %> ios record <instance-ID> start',
    '<%= config.bin %> ios record <instance-ID> stop -o recording.mp4',
    '<%= config.bin %> ios record <instance-ID> start --quality 8',
  ];

  static args = {
    action: Args.string({ description: 'start or stop', required: true, options: ['start', 'stop'] }),
    id: Args.string({ description: 'Instance ID (defaults to last created)', required: false }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    quality: Flags.integer({ description: 'Recording quality (5-10)', default: 5 }),
    output: Flags.string({ char: 'o', description: 'Save recording to file (for stop action)' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ExecRecord);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(args.id);
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
        const saveTo: { localPath?: string } = {};
        if (flags.output) saveTo.localPath = path.resolve(flags.output);

        if (hasActiveSession(id)) {
          const url = await sendSessionCommand(id, 'stop-recording', [saveTo]);
          if (flags.output) {
            this.log(`Recording saved to ${flags.output}`);
          } else {
            this.log(`Recording download URL: ${url}`);
          }
        } else {
          const { client, disconnect } = await getInstanceClient(this.client, id);
          try {
            const url = await (client as any).stopRecording(saveTo);
            if (flags.output) {
              this.log(`Recording saved to ${flags.output}`);
            } else {
              this.log(`Recording download URL: ${url}`);
            }
          } finally {
            disconnect();
          }
        }
      }
    });
  }
}
