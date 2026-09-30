import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { getAndroidInstanceClient } from '../../../lib/instance-client-factory';

export default class AndroidCaAdd extends BaseCommand {
  static summary = 'Trust a CA certificate on a running Android instance';
  static description =
    "Add a PEM-encoded CA certificate to the device's system trust store, for example the CA of an " +
    'intercepting proxy you record traffic with. Apps and WebViews trust it on their next connection, ' +
    'without a restart; the Chrome browser does not use it. The certificate lasts as long as the instance.';

  static examples = [
    '<%= config.bin %> android ca add ./proxy-ca.pem',
    '<%= config.bin %> android ca add ./proxy-ca.pem --id <instance-ID>',
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
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AndroidCaAdd);
    this.setParsedFlags(flags);
    const localPath = path.resolve(args.path);
    if (!fs.existsSync(localPath)) {
      this.error(`File not found: ${localPath}`);
    }
    const pem = fs.readFileSync(localPath);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const trusted = await client.addCaCertificate(pem);
        if (flags.json) {
          this.outputJson(trusted);
        } else {
          this.output(`Trusted ${trusted.filename} (SHA-256 ${trusted.sha256})`);
        }
      } finally {
        disconnect();
      }
    });
  }
}
