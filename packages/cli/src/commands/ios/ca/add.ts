import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getIosInstanceClient } from '../../../lib/instance-client-factory';

export default class IosCaAdd extends BaseCommand {
  static summary = 'Trust a CA certificate on a running iOS instance';
  static description =
    "Add a PEM-encoded CA certificate to the simulator's trusted roots, for example the CA of an " +
    'intercepting proxy you record traffic with. Safari and apps trust it on their next connection, ' +
    'without a restart. The certificate lasts for the life of the instance.';

  static examples = [
    '<%= config.bin %> ios ca add ./proxy-ca.pem',
    '<%= config.bin %> ios ca add ./proxy-ca.pem --id <instance-ID>',
  ];

  static args = {
    path: Args.string({
      description: 'Local PEM file holding one CA certificate.',
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
    const { args, flags } = await this.parse(IosCaAdd);
    this.setParsedFlags(flags);
    const localPath = path.resolve(args.path);
    if (!fs.existsSync(localPath)) {
      this.error(`File not found: ${localPath}`);
    }
    const pem = fs.readFileSync(localPath, 'utf8');

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
      try {
        const trusted = await client.addCaCertificate(pem);
        if (flags.json) {
          this.outputJson(trusted);
        } else {
          this.output(`Trusted the CA (SHA-256 ${trusted.sha256})`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
