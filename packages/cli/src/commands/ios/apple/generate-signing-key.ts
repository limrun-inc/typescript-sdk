import { Flags } from '@oclif/core';
import { generateAppleSigningKeyAndCSR } from '@limrun/apple-auth';
import { BaseCommand } from '../../../base-command';
import { savePrivateFile } from '../../../lib/store-output';

export default class GenerateAppleSigningKey extends BaseCommand {
  static summary = 'Generate a local signing key and certificate signing request';
  static flags = {
    ...BaseCommand.baseFlags,
    'common-name': Flags.string({ description: 'CSR common name.', required: true }),
    email: Flags.string({ description: 'CSR email address.' }),
    'private-key-output': Flags.string({
      description: 'Destination PKCS8 DER private key. Must not exist.',
      required: true,
    }),
    'csr-output': Flags.string({ description: 'Destination PEM CSR. Must not exist.', required: true }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(GenerateAppleSigningKey);
    this.setParsedFlags(flags);
    await savePrivateFile(flags['private-key-output'], async () => {
      let privateKey: Buffer;
      await savePrivateFile(flags['csr-output'], async () => {
        const material = await generateAppleSigningKeyAndCSR({
          commonName: flags['common-name'],
          emailAddress: flags.email,
        });
        privateKey = Buffer.from(material.privateKeyPKCS8Base64, 'base64');
        return material.csrPEM;
      });
      return privateKey!;
    });
    this.outputJson({ privateKeyOutput: flags['private-key-output'], csrOutput: flags['csr-output'] });
  }
}
