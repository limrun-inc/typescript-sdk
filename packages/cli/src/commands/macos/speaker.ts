import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { defaultSpeakerRecordingPath } from '../../lib/speaker-recording';

export default class MacosSpeaker extends BaseCommand {
  static summary = "Record a macOS instance's speaker to a WAV file";
  static description =
    "Record the guest's speaker output. Start returns a recording ID; stop takes one, or stops the most " +
    'recently started speaker recording, and downloads a 48 kHz mono WAV file. The speaker records whether ' +
    'or not anyone is listening to the stream. Up to eight speaker recordings can run at once. Screen ' +
    'recordings include the speaker too; see `macos record`.';
  static examples = [
    '<%= config.bin %> macos speaker start',
    '<%= config.bin %> macos speaker stop -o speaker.wav',
    '<%= config.bin %> macos speaker start run-1 --id <instance-ID>',
    '<%= config.bin %> macos speaker stop run-1 -o run-1.wav',
  ];

  static args = {
    action: Args.string({
      description: '`start` begins recording the speaker and `stop` finishes and downloads the WAV file',
      required: true,
      options: ['start', 'stop'],
    }),
    recordingId: Args.string({
      description:
        'Recording ID. Generated on start when omitted; stop selects the latest speaker recording when omitted.',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    output: Flags.string({
      char: 'o',
      description:
        'Local file path for the WAV file. Applies to stop. Defaults to a timestamped wav in the current directory.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosSpeaker);
    this.setParsedFlags(flags);
    if (flags.output && args.action !== 'stop') this.error('--output only applies to the `stop` action.');

    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      if (args.action === 'start') {
        const recordingId = await client.startSpeakerRecording({
          ...(args.recordingId !== undefined && { recordingId: args.recordingId }),
        });
        this.outputResult(
          { ok: true, instanceId: id, speakerRecording: true, recordingId },
          `Speaker recording started: ${recordingId}`,
        );
        return;
      }
      const localPath = flags.output ? path.resolve(flags.output) : defaultSpeakerRecordingPath();
      await client.stopSpeakerRecording(args.recordingId, { localPath });
      this.outputResult(
        { ok: true, instanceId: id, speakerRecording: false, localPath },
        `Speaker recording saved to ${localPath}`,
      );
    });
  }
}
