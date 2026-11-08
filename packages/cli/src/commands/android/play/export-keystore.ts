import { Flags } from '@oclif/core';
import { resolve } from 'node:path';
import { ANDROID_SIGNING_KEY_SECRET_TYPE } from '@limrun/play-auth';
import { BaseCommand } from '../../../base-command';
import { LocalSecretStore } from '../../../lib/local-secret-store';
import { savePrivateFiles } from '../../../lib/store-output';

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
    await savePrivateFiles([flags.output, flags['credentials-output']], async () => [
      Buffer.from(keystoreBase64, 'base64'),
      JSON.stringify({ keystorePassword, keyAlias, keyPassword }, null, 2) + '\n',
    ]);
    this.outputJson({ output: resolve(flags.output), credentialsOutput: flags['credentials-output'] });
  }
}
