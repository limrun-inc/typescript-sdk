import { Flags } from '@oclif/core';
import { ANDROID_SIGNING_KEY_SECRET_TYPE } from '@limrun/play-auth';
import { BaseCommand } from '../../../base-command';
import { LocalSecretStore } from '../../../lib/local-secret-store';
import { savePrivateFile } from '../../../lib/store-output';

export default class ExportPlayKeystore extends BaseCommand {
  static summary = 'Export a local upload keystore and its signing credentials to files';
  static flags = {
    ...BaseCommand.baseFlags,
    'application-id': Flags.string({ description: 'Android application ID.', required: true }),
    output: Flags.string({ description: 'Destination PKCS12 keystore. Must not exist.', required: true }),
    'credentials-output': Flags.string({
      description: 'Destination JSON containing keystorePassword, keyAlias, and keyPassword. Must not exist.',
      required: true,
    }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(ExportPlayKeystore);
    this.setParsedFlags(flags);
    const secret = await new LocalSecretStore().get(ANDROID_SIGNING_KEY_SECRET_TYPE, flags['application-id']);
    if (!secret?.data.keystoreBase64) this.error('No local upload keystore was found for this application.');
    const { keystoreBase64, keystorePassword, keyAlias, keyPassword } = secret.data;
    const result = await savePrivateFile(flags.output, async () => {
      await savePrivateFile(
        flags['credentials-output'],
        async () => JSON.stringify({ keystorePassword, keyAlias, keyPassword }, null, 2) + '\n',
      );
      return Buffer.from(keystoreBase64, 'base64');
    });
    this.outputJson({ ...result, credentialsOutput: flags['credentials-output'] });
  }
}
