import { Args, Flags } from '@oclif/core';
import type { RestartableService } from '@limrun/api/ios-client';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

const SERVICES: RestartableService[] = [
  'com.apple.SpringBoard',
  'com.apple.locationd',
  'com.apple.tccd',
  'com.apple.akd',
];

export default class IosRestartServices extends BaseCommand {
  static summary = 'Restart system services on a running iOS instance';
  static description = `Restart system services so they reload their settings, for example so system prompts follow a new language set with \`lim ios simctl -- spawn booted defaults write\`. Restarting SpringBoard closes every running app; the command returns once SpringBoard is back. Services: ${SERVICES.join(
    ', ',
  )}.`;
  static examples = [
    '<%= config.bin %> ios restart-services com.apple.SpringBoard',
    '<%= config.bin %> ios restart-services com.apple.SpringBoard com.apple.locationd com.apple.tccd com.apple.akd',
  ];

  static strict = false;
  static args = {
    service: Args.string({
      description: 'Service to restart. Pass several to restart them in order.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(IosRestartServices);
    this.setParsedFlags(flags);
    const services = argv as string[];
    const unknown = services.filter((service) => !(SERVICES as string[]).includes(service));
    if (unknown.length > 0) {
      this.error(`Unknown service ${unknown.join(', ')}. Services: ${SERVICES.join(', ')}`);
    }

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        await client.restartServices(services as RestartableService[]);
      } finally {
        disconnect();
      }
      this.outputResult(
        { ok: true, instanceId: resolvedInstance.id, services },
        `Restarted ${services.join(', ')}`,
      );
    });
  }
}
