import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseDurationSeconds } from '../../lib/duration';

export default class MacosRecord extends BaseCommand {
  static summary = 'Start or stop a screen recording on a macOS instance';
  static description =
    'Record the screen of a running macOS instance. Start returns a recording ID; stop takes one, or stops ' +
    'the most recently started recording that is still active. Up to eight recordings can run at once. ' +
    "Recordings include the guest's speaker as an audio track; use --no-audio to leave it out. Stop " +
    'downloads the MP4 to a local file, and with `--presigned-url` the instance also uploads it there.';
  static examples = [
    '<%= config.bin %> macos record start',
    '<%= config.bin %> macos record stop -o recording.mp4',
    '<%= config.bin %> macos record start run-1 --quality 8',
    '<%= config.bin %> macos record stop run-1 --presigned-url https://example.com/upload',
    '<%= config.bin %> macos record start --persist --persist-ttl 24h',
    '<%= config.bin %> macos record start --no-audio',
  ];

  static args = {
    action: Args.string({
      description: '`start` begins recording and `stop` finishes the MP4',
      required: true,
      options: ['start', 'stop'],
    }),
    recordingId: Args.string({
      description:
        'Recording ID. Generated on start when omitted; stop selects the latest active recording when omitted.',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
    audio: Flags.boolean({
      description:
        "Record the instance's speaker as the video's audio track. Enabled by default. Applies to start.",
      default: true,
      allowNo: true,
    }),
    quality: Flags.integer({
      description:
        'Recording quality from 5 to 10. Higher values increase quality and file size. Applies to start.',
      default: 5,
    }),
    output: Flags.string({
      char: 'o',
      description:
        'Local file path for the finished recording. Applies to stop. Defaults to a timestamped mp4 in the current directory.',
    }),
    'presigned-url': Flags.string({
      description: 'Presigned upload URL the instance uploads the finished recording to. Applies to stop.',
    }),
    persist: Flags.boolean({
      description:
        'Persist the recording to Limrun storage when it stops or the instance terminates. Applies to start. List results with `lim macos recordings`.',
      default: false,
    }),
    'persist-ttl': Flags.string({
      description:
        'How long the persisted recording is kept, as a duration like 72h or 90m. Requires --persist. Defaults to 72h.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosRecord);
    this.setParsedFlags(flags);
    if (flags['persist-ttl'] && !flags.persist) this.error('--persist-ttl requires --persist.');
    if (flags.persist && args.action !== 'start') this.error('--persist only applies to the `start` action.');

    await this.withAuth(async () => {
      const { id, client } = await this.resolveMacosClient(flags.id);
      if (args.action === 'start') {
        const persist =
          flags.persist ?
            flags['persist-ttl'] ?
              { ttlSeconds: parseDurationSeconds(flags['persist-ttl']) }
            : true
          : undefined;
        const recordingId = await client.startRecording({
          ...(args.recordingId !== undefined && { recordingId: args.recordingId }),
          quality: flags.quality,
          audio: flags.audio,
          ...(persist !== undefined && { persist }),
        });
        this.outputResult(
          {
            ok: true,
            instanceId: id,
            recording: true,
            recordingId,
            quality: flags.quality,
            persist: Boolean(persist),
            audio: flags.audio,
          },
          persist ?
            `Recording ${recordingId} started; it will be persisted for ${
              flags['persist-ttl'] ?? '72h'
            } when it stops.`
          : `Recording started: ${recordingId}`,
        );
        return;
      }
      const localPath = flags.output ? path.resolve(flags.output) : defaultRecordingPath();
      await client.stopRecording(args.recordingId, {
        localPath,
        ...(flags['presigned-url'] && { presignedUrl: flags['presigned-url'] }),
      });
      this.outputResult(
        { ok: true, instanceId: id, recording: false, localPath, uploaded: Boolean(flags['presigned-url']) },
        `Recording saved to ${localPath}`,
      );
    });
  }
}

function defaultRecordingPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), `video_${timestamp}.mp4`);
}
