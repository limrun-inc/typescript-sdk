import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { setLastInstance } from '../../lib/config';
import { buildManualInstanceRecord } from '../../lib/set-instance';

export default class GradleSetInstance extends BaseCommand {
  static summary = 'Set the gradle instance targeted by subsequent commands';
  static description =
    'Pin an existing gradle instance as the target of subsequent `lim gradle` commands using only its API URL and token — no LIM_API_KEY needed. ' +
    'Made for handing a single instance to a sandboxed agent: the creator passes the URL and token from `lim gradle create --json` (status.apiUrl and status.token). ' +
    'To target the instance without persisting anything, export LIM_GRADLE_INSTANCE_URL and LIM_GRADLE_INSTANCE_TOKEN instead; commands pick them up directly.';
  static examples = [
    '<%= config.bin %> gradle set-instance --api-url https://eu-north1.limrun.com/v1/gradle_.../api --token lim_st_...',
    'LIM_GRADLE_INSTANCE_TOKEN=lim_st_... <%= config.bin %> gradle set-instance --api-url https://.../api',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'api-url': Flags.string({
      description: "The instance's API URL (status.apiUrl). Can also be set via LIM_GRADLE_INSTANCE_URL.",
      env: 'LIM_GRADLE_INSTANCE_URL',
      required: true,
    }),
    token: Flags.string({
      description: "The instance's token (status.token). Can also be set via LIM_GRADLE_INSTANCE_TOKEN.",
      env: 'LIM_GRADLE_INSTANCE_TOKEN',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(GradleSetInstance);
    this.setParsedFlags(flags);

    const record = buildManualInstanceRecord({
      type: 'gradle',
      apiUrl: flags['api-url'],
      token: flags.token,
    });
    setLastInstance(record);

    if (flags.json) {
      this.outputJson({ id: record.id, type: record.type, apiUrl: record.apiUrl });
      return;
    }
    this.output(`Set ${record.id} as the target gradle instance${this.scopeSuffix()}.`);
    this.info('Subsequent `lim gradle` commands will use it without an API key.');
  }
}
