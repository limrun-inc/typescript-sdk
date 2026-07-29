import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getBuildLogs } from '../../lib/build-logs';

export default class GradleLogs extends BaseCommand {
  static summary = 'Fetch logs for an active, recent, or specific Gradle build';
  static description =
    'Print the active build log, or the latest persisted log when no build is active. Pass an exec ID to select a specific build. Active logs are a point-in-time snapshot unless --follow is set.';
  static baseFlags = BaseCommand.readOnlyFlags as unknown as typeof BaseCommand.baseFlags;

  static examples = [
    '<%= config.bin %> gradle logs',
    '<%= config.bin %> gradle logs --follow',
    '<%= config.bin %> gradle logs build-1776140344112378000',
    '<%= config.bin %> gradle logs build-1776140344112378000 --id <gradle-instance-ID>',
  ];

  static args = {
    execId: Args.string({
      description: 'Build exec ID. Defaults to the active build, then the latest persisted build.',
      required: false,
    }),
  };

  static flags = {
    id: Flags.string({
      description: 'Gradle instance ID. Defaults to the most recently used Gradle target.',
    }),
    follow: Flags.boolean({
      description: 'Continue streaming an active build until it reaches a terminal state.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(GradleLogs);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const target = this.resolveGradleTarget(flags.id);
      const result = await getBuildLogs({
        instanceId: target.id,
        ...(args.execId && { execId: args.execId }),
        follow: flags.follow,
        listPersisted: () => this.client.gradleInstances.listBuildLogs(target.id),
        observe: async (execId, options) => {
          const gradleClient = await this.resolveGradleClient(target);
          return gradleClient.observeBuildLogs(execId, options);
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
