import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { setLastInstance } from '../../lib/config';
import { buildManualInstanceRecord } from '../../lib/set-instance';

export default class XcodeSetInstance extends BaseCommand {
  static summary = 'Set the Xcode instance targeted by subsequent commands';
  static description =
    'Pin an existing Xcode instance as the target of subsequent `lim xcode` commands using only its API URL and token — no LIM_API_KEY needed. ' +
    'Works with a standalone Xcode instance (status.apiUrl and status.token from `lim xcode create --json`) or with the embedded Xcode sandbox of a legacy paired iOS instance (status.sandbox.xcode.url and status.token). ' +
    'To target the instance without persisting anything, export LIM_XCODE_INSTANCE_URL and LIM_XCODE_INSTANCE_TOKEN instead; commands pick them up directly.';
  static examples = [
    '<%= config.bin %> xcode set-instance --api-url https://eu-north1.limrun.com/v1/xcode_.../api --token lim_st_...',
    '<%= config.bin %> xcode set-instance --api-url https://.../v1/sandbox_.../api --token lim_st_...',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'api-url': Flags.string({
      description:
        "The instance's API URL (status.apiUrl, or status.sandbox.xcode.url of an iOS instance). Can also be set via LIM_XCODE_INSTANCE_URL.",
      env: 'LIM_XCODE_INSTANCE_URL',
      required: true,
    }),
    token: Flags.string({
      description: "The instance's token (status.token). Can also be set via LIM_XCODE_INSTANCE_TOKEN.",
      env: 'LIM_XCODE_INSTANCE_TOKEN',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeSetInstance);
    this.setParsedFlags(flags);

    const record = buildManualInstanceRecord({
      type: 'xcode',
      apiUrl: flags['api-url'],
      token: flags.token,
    });
    setLastInstance(record);

    if (flags.json) {
      this.outputJson({ id: record.id, type: record.type, apiUrl: record.apiUrl });
      return;
    }
    this.output(`Set ${record.id} as the target Xcode instance${this.scopeSuffix()}.`);
    this.info('Subsequent `lim xcode` commands will use it without an API key.');
  }
}
