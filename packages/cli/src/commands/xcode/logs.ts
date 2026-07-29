import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getBuildLogs } from '../../lib/build-logs';

export default class XcodeLogs extends BaseCommand {
  static summary = 'Fetch logs for an active, recent, or specific Xcode build';
  static description =
    'Print the active build log, or the latest persisted log when no build is active. Pass an exec ID to select a specific build. Active logs are a point-in-time snapshot unless --follow is set.';
  static baseFlags = BaseCommand.readOnlyFlags as unknown as typeof BaseCommand.baseFlags;

  static examples = [
    '<%= config.bin %> xcode logs',
    '<%= config.bin %> xcode logs --follow',
    '<%= config.bin %> xcode logs build-1776140344112378000',
    '<%= config.bin %> xcode logs build-1776140344112378000 --id <xcode-instance-ID>',
  ];

  static args = {
    execId: Args.string({
      description: 'Build exec ID. Defaults to the active build, then the latest persisted build.',
      required: false,
    }),
  };

  static flags = {
    id: Flags.string({
      description: 'Xcode or iOS-backed Xcode instance ID. Defaults to the most recently used Xcode target.',
    }),
    follow: Flags.boolean({
      description: 'Continue streaming an active build until it reaches a terminal state.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeLogs);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const result = await getBuildLogs({
        instanceId: target.id,
        ...(args.execId && { execId: args.execId }),
        follow: flags.follow,
        listPersisted: () => this.client.xcodeInstances.listBuildLogs(target.id),
        observe: async (execId, options) => {
          const xcodeClient = await this.resolveXcodeClient(target);
          return xcodeClient.observeBuildLogs(execId, options);
        },
        ...(!flags.json && {
          onText: (text: string, stream: 'stdout' | 'stderr') => {
            (stream === 'stderr' ? process.stderr : process.stdout).write(text);
          },
        }),
      });

      if (flags.json) {
        this.outputJson(result);
        return;
      }
      this.logToStderr(
        `Build ${result.execId} is ${result.status}${
          result.exitCode === undefined ? '' : ` (exit ${result.exitCode})`
        }.`,
      );
      if (result.status === 'RUNNING' && !flags.follow) {
        this.logToStderr(
          'Re-run this command for a fresh snapshot, or pass --follow to wait for completion.',
        );
      }
    });
  }
}
