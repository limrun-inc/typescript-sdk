import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { detectInstanceType, getInstanceClient } from '../../lib/instance-client-factory';

export default class IosCp extends BaseCommand {
  static summary = 'Copy a local file into the iOS sandbox';
  static description =
    'Upload a local file into the simulator sandbox and return the remote path that can be used by follow-up commands such as `ios simctl`.';
  static examples = [
    '<%= config.bin %> ios cp test.txt ./fixtures/test.txt',
    '<%= config.bin %> ios cp input.json ./payloads/input.json --json',
  ];

  static args = {
    name: Args.string({
      description: 'Filename to use inside the simulator sandbox.',
      required: true,
    }),
    path: Args.string({
      description: 'Local file path to upload into the simulator sandbox.',
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
    const { args, flags } = await this.parse(IosCp);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios cp only supports iOS instances');
      }

      const localPath = path.resolve(args.path);
      if (!fs.existsSync(localPath)) {
        this.error(`File not found: ${localPath}`);
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'ios') {
          this.error('ios cp only supports iOS instances');
        }

        const sandboxPath = await (client as any).cp(args.name, localPath);
        if (flags.json) {
          this.outputJson({ sandboxPath });
        } else {
          this.output(sandboxPath);
        }
      } finally {
        disconnect();
      }
    });
  }
}
