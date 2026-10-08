import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { parseDurationSeconds } from '../../lib/duration';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosRecord extends BaseCommand {
  static summary = 'Start or stop video recording on a running iOS instance';
  static description =
    'Control screen recording on a running iOS instance. Start recording first, then stop recording to download the file locally or upload it directly with `--presigned-url`.';
  static examples = [
    '<%= config.bin %> ios record start',
    '<%= config.bin %> ios record start --segments',
    '<%= config.bin %> ios record stop --segments -o recording',
    '<%= config.bin %> ios record stop',
    '<%= config.bin %> ios record stop -o recording.mp4 --id <instance-ID>',
    '<%= config.bin %> ios record stop --presigned-url https://example.com/upload --id <instance-ID>',
    '<%= config.bin %> ios record start --quality 8',
    '<%= config.bin %> ios record start --persist --persist-ttl 24h',
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
    display: Flags.string({
      options: ['inner', 'outer'],
      description: 'Record one Duo panel instead of following the active display. Applies to start.',
    }),
    id: Flags.string({
      description: 'iOS instance ID to record. Defaults to the last created iOS instance.',
    }),
    segments: Flags.boolean({
      description:
        'Start a new MP4 part on display rotation. Use on both start and stop; -o names a directory containing the parts and recording.json.',
      default: false,
    }),
    quality: Flags.integer({
      description:
        'Recording quality from 5 to 10. Higher values increase quality and file size when starting a recording.',
      default: 5,
    }),
    output: Flags.string({
      char: 'o',
      description:
        'Output file for `stop`, or output directory with --segments. Defaults to a timestamped path in the current directory.',
    }),
    'presigned-url': Flags.string({
      description:
        'Presigned upload URL to receive the recording when using the `stop` action. Use this if you will upload the recording to a bucket.',
    }),
    persist: Flags.boolean({
      description:
        'Persist the recording to Limrun storage when it stops or the instance terminates, when using the `start` action. List results with `lim ios recordings`.',
      default: false,
    }),
    'persist-ttl': Flags.string({
      description:
        'How long the persisted recording is kept, as a duration like 72h or 90m. Requires --persist. Defaults to 72h.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IosRecord);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('ios record only supports iOS instances');
      }

      if (flags['persist-ttl'] && !flags.persist) {
        this.error('--persist-ttl requires --persist.');
      }
      if (flags.display && args.action !== 'start') {
        this.error('--display only applies to the `start` action.');
      }
      if (flags.persist && args.action !== 'start') {
        this.error('--persist only applies to the `start` action.');
      }

      if (flags.segments && flags['presigned-url']) {
        this.error('--segments cannot use a single --presigned-url; use --persist or download the parts.');
      }
      if (args.action === 'start') {
        const persist =
          flags.persist ?
            flags['persist-ttl'] ?
              { ttlSeconds: parseDurationSeconds(flags['persist-ttl']) }
            : true
          : undefined;
        // Older daemons drop persistence and display options, so send those starts directly.
        if (!persist && !flags.display && !flags.segments && (await ensureDaemonSession(resolvedInstance))) {
          await sendSessionCommand(id, 'start-recording', [flags.quality]);
        } else {
          const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
          try {
            await client.startRecording({
              segmentOnRotation: flags.segments,
              quality: flags.quality,
              persist,
              display: flags.display as 'inner' | 'outer' | undefined,
            });
          } finally {
            disconnect();
          }
        }
        this.log(
          persist ?
            `Recording started; it will be persisted for ${flags['persist-ttl'] ?? '72h'} when it stops.`
          : 'Recording started',
        );
        return;
      }

      if (flags.segments) {
        const directory =
          flags.output ? path.resolve(flags.output) : this.defaultRecordingPath().replace(/\.mp4$/, '');
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          const parts = await client.stopRecordingSegments({ localDirectory: directory });
          if (flags.json) this.outputJson(parts);
          else this.log(`Saved ${parts.length} recording segments and recording.json to ${directory}`);
        } finally {
          disconnect();
        }
        return;
      }

      const outputPath = flags.output ? path.resolve(flags.output) : this.defaultRecordingPath();
      const saveTo = {
        localPath: outputPath,
        presignedUrl: flags['presigned-url'],
      };

      if (await ensureDaemonSession(resolvedInstance)) {
        await sendSessionCommand(id, 'stop-recording', [saveTo]);
        this.log(`Recording saved to ${outputPath}`);
        if (flags['presigned-url']) {
          this.log('Recording uploaded using the provided presigned URL');
        }
        return;
      }

      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.stopRecording(saveTo);
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
