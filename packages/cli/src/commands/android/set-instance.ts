import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { setLastInstance } from '../../lib/config';
import { buildManualInstanceRecord } from '../../lib/set-instance';

export default class AndroidSetInstance extends BaseCommand {
  static summary = 'Set the Android instance targeted by subsequent commands';
  static description =
    'Pin an existing Android instance as the target of subsequent `lim android` commands using only its API URL and token — no LIM_API_KEY needed. ' +
    'Made for handing a single instance to a sandboxed agent: the creator passes the URL and token from `lim android create --json` (status.apiUrl and status.token). ' +
    'Pass --adb-websocket-url (status.adbWebSocketUrl) as well if the agent should run `lim android connect`. ' +
    'To target the instance without persisting anything, export LIM_ANDROID_INSTANCE_URL and LIM_ANDROID_INSTANCE_TOKEN instead; commands pick them up directly.';
  static examples = [
    '<%= config.bin %> android set-instance --api-url https://eu-north1.limrun.com/v1/android_.../api --token lim_st_...',
    '<%= config.bin %> android set-instance --api-url https://.../api --token lim_st_... --adb-websocket-url wss://...',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'api-url': Flags.string({
      description: "The instance's API URL (status.apiUrl). Can also be set via LIM_ANDROID_INSTANCE_URL.",
      env: 'LIM_ANDROID_INSTANCE_URL',
      required: true,
    }),
    token: Flags.string({
      description: "The instance's token (status.token). Can also be set via LIM_ANDROID_INSTANCE_TOKEN.",
      env: 'LIM_ANDROID_INSTANCE_TOKEN',
      required: true,
    }),
    'adb-websocket-url': Flags.string({
      description:
        "The instance's ADB WebSocket URL (status.adbWebSocketUrl), needed only for `lim android connect`. Can also be set via LIM_ANDROID_INSTANCE_ADB_URL.",
      env: 'LIM_ANDROID_INSTANCE_ADB_URL',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidSetInstance);
    this.setParsedFlags(flags);

    const record = buildManualInstanceRecord({
      type: 'android',
      apiUrl: flags['api-url'],
      token: flags.token,
      ...(flags['adb-websocket-url'] ? { adbWebSocketUrl: flags['adb-websocket-url'] } : {}),
    });
    setLastInstance(record);

    if (flags.json) {
      this.outputJson({ id: record.id, type: record.type, apiUrl: record.apiUrl });
      return;
    }
    this.output(`Set ${record.id} as the target Android instance${this.scopeSuffix()}.`);
    this.info('Subsequent `lim android` commands will use it without an API key.');
  }
}
