import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { setLastInstance } from '../../lib/config';
import { buildManualInstanceRecord } from '../../lib/set-instance';

export default class IosSetInstance extends BaseCommand {
  static summary = 'Set the iOS instance targeted by subsequent commands';
  static description =
    'Pin an existing iOS instance as the target of subsequent `lim ios` commands using only its API URL and token — no LIM_API_KEY needed. ' +
    'Made for handing a single instance to a sandboxed agent: the creator passes the URL and token from `lim ios create --json` (status.apiUrl and status.token). ' +
    'To target the instance without persisting anything, export LIM_IOS_INSTANCE_URL and LIM_IOS_INSTANCE_TOKEN instead; commands pick them up directly.';
  static examples = [
    '<%= config.bin %> ios set-instance --api-url https://eu-north1.limrun.com/v1/ios_.../api --token lim_st_...',
    'LIM_IOS_INSTANCE_TOKEN=lim_st_... <%= config.bin %> ios set-instance --api-url https://.../api',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'api-url': Flags.string({
      description: "The instance's API URL (status.apiUrl). Can also be set via LIM_IOS_INSTANCE_URL.",
      env: 'LIM_IOS_INSTANCE_URL',
      required: true,
    }),
    token: Flags.string({
      description: "The instance's token (status.token). Can also be set via LIM_IOS_INSTANCE_TOKEN.",
      env: 'LIM_IOS_INSTANCE_TOKEN',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosSetInstance);
    this.setParsedFlags(flags);

    const record = buildManualInstanceRecord({
      type: 'ios',
      apiUrl: flags['api-url'],
      token: flags.token,
    });
    setLastInstance(record);

    if (flags.json) {
      this.outputJson({ id: record.id, type: record.type, apiUrl: record.apiUrl });
      return;
    }
    this.output(`Set ${record.id} as the target iOS instance${this.scopeSuffix()}.`);
    this.info('Subsequent `lim ios` commands will use it without an API key.');
  }
}
