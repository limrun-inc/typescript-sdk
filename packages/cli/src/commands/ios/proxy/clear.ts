import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { iosProxyToolError, proxyChangedMessage } from '../../../lib/device-proxy';
import { runIosSimctl } from '../../../lib/instance-client-factory';

export default class IosProxyClear extends BaseCommand {
  static summary = 'Clear the system proxy of a running iOS instance';
  static description =
    'Restore the system proxy settings that `lim ios proxy set` replaced, so new connections go direct ' +
    'again. Clearing a proxy that was never set does nothing. Same as ' +
    '`lim ios simctl -- spawn booted limproxy clear`.';
  static examples = [
    '<%= config.bin %> ios proxy clear',
    '<%= config.bin %> ios proxy clear --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosProxyClear);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const result = await runIosSimctl(this.client, this.resolveIosInstance(flags.id), [
        'spawn',
        'booted',
        'limproxy',
        'clear',
      ]);
      if (result.code !== 0) {
        this.error(iosProxyToolError(result), { exit: result.code });
      }
      if (flags.json) {
        this.outputJson({ proxy: null });
      } else {
        this.output(proxyChangedMessage(null));
      }
    });
  }
}
