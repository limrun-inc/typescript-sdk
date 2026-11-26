import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';

export default class MacosCaAdd extends BaseCommand {
  static summary = 'Trust a CA certificate on a macOS instance';
  static description =
    "Add a PEM-encoded CA certificate to the guest's system trust settings, for example the CA of an " +
    'intercepting proxy you record traffic with. Safari and apps that use the system trust store accept it on ' +
    'their next connection. macOS asks an administrator to confirm a new trusted root, so the instance answers ' +
    'that dialog itself, and it shows on the screen for a few seconds.';
  static examples = [
    '<%= config.bin %> macos ca add ./proxy-ca.pem',
    '<%= config.bin %> macos ca add ./proxy-ca.pem --id <instance-ID>',
  ];

  static args = {
    path: Args.string({ description: 'Local PEM file holding one CA certificate.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'macOS instance ID. Defaults to the last created macOS instance.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(MacosCaAdd);
    this.setParsedFlags(flags);
    const localPath = path.resolve(args.path);
    if (!fs.existsSync(localPath)) this.error(`File not found: ${localPath}`);
    const pem = fs.readFileSync(localPath, 'utf8');
    await this.withAuth(async () => {
      const { client } = await this.resolveMacosClient(flags.id);
      const trusted = await client.addCaCertificate(pem);
      if (flags.json) this.outputJson(trusted);
      else this.output(`Trusted the CA (SHA-256 ${trusted.sha256})`);
    });
  }
}
