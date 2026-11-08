import { Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
import { exportAppleCertificateP12 } from '@limrun/apple-auth';
import { BaseCommand } from '../../../base-command';
import { savePrivateFile } from '../../../lib/store-output';

export default class ExportAppleCertificateP12 extends BaseCommand {
  static summary = 'Combine a local PKCS8 signing key and DER certificate into a P12';
  static flags = {
    ...BaseCommand.baseFlags,
    'private-key': Flags.string({
      description: 'PKCS8 DER private key from generate-signing-key.',
      required: true,
    }),
    certificate: Flags.string({ description: 'DER certificate from download-certificate.', required: true }),
    'password-file': Flags.string({
      description: 'File containing the P12 password. A trailing newline is removed.',
      required: true,
    }),
    'friendly-name': Flags.string({ description: 'P12 friendly name.' }),
    output: Flags.string({ description: 'Destination P12. Must not exist.', required: true }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(ExportAppleCertificateP12);
    this.setParsedFlags(flags);
    const output = await savePrivateFile(flags.output, async () => {
      const password = (await readFile(flags['password-file'], 'utf8')).replace(/\r?\n$/, '');
      const p12 = exportAppleCertificateP12({
        privateKeyPKCS8Base64: (await readFile(flags['private-key'])).toString('base64'),
        certificateBase64: (await readFile(flags.certificate)).toString('base64'),
        password,
        friendlyName: flags['friendly-name'],
      });
      return Buffer.from(p12, 'base64');
    });
    this.outputJson(output);
  }
}
