import { Flags } from '@oclif/core';
import { generateAndroidUploadKeystore, ANDROID_SIGNING_KEY_SECRET_TYPE } from '@limrun/play-auth';
import { BaseCommand } from '../../../base-command';
import { LocalSecretStore } from '../../../lib/local-secret-store';

export default class GeneratePlayKeystore extends BaseCommand {
  static summary = 'Generate and save an Android upload keystore on this computer';
  static description =
    'Keeps the key in ~/.lim/secrets. Refuses to replace an existing local key. This does not register the key with Google or change the upload key stored in Limrun.';
  static flags = {
    ...BaseCommand.baseFlags,
    'application-id': Flags.string({ description: 'Android application ID.', required: true }),
  };
  async run(): Promise<void> {
    const { flags } = await this.parse(GeneratePlayKeystore);
    this.setParsedFlags(flags);
    const store = new LocalSecretStore();
    const name = flags['application-id'];
    if (await store.get(ANDROID_SIGNING_KEY_SECRET_TYPE, name))
      this.error(
        'An upload key already exists locally for this application. Use export-keystore to reuse it.',
      );
    await store.create(ANDROID_SIGNING_KEY_SECRET_TYPE, name, await generateAndroidUploadKeystore(name));
    this.outputJson({ name, directory: store.directory });
  }
}
