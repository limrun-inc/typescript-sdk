import fs from 'fs';
import path from 'path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../base-command';

export function buildPullFileCommand(platform: 'xcode' | 'gradle'): typeof BaseCommand {
  return class BuildPullFile extends BaseCommand {
    static summary = `Download a file from a ${platform === 'xcode' ? 'Xcode' : 'Gradle'} sandbox`;
    static description =
      'Stream a file from the build sandbox over HTTP and save it locally. ' +
      'Use an absolute path, or a path relative to the synced project root. Symlinks and parent paths follow filesystem permissions. ' +
      'Wait for the command writing the file to finish. Archive directories before downloading them.';
    static examples = [
      `<%= config.bin %> ${platform} pull-file /tmp/app.zip ./app.zip`,
      `<%= config.bin %> ${platform} pull-file artifacts/app.zip`,
      `<%= config.bin %> ${platform} pull-file reports/test.xml ./test.xml --id <instance-ID>`,
    ];
    static args = {
      path: Args.string({
        description: 'Absolute file path or path relative to the synced project root.',
        required: true,
      }),
      destination: Args.string({
        description:
          'Local file path or existing directory. Defaults to the remote filename in the current directory. Replaces an existing file after a successful download.',
      }),
    };
    static flags = {
      ...BaseCommand.baseFlags,
      id: Flags.string({ description: `${platform} instance ID. Defaults to the last used instance.` }),
    };

    async run(): Promise<void> {
      const { args, flags } = await this.parse(BuildPullFile);
      this.setParsedFlags(flags);
      await this.withAuth(
        async () => {
          let localPath = path.resolve(args.destination ?? path.posix.basename(args.path));
          if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
            localPath = path.join(localPath, path.posix.basename(args.path));
          }
          const { client } = await this.resolveBuildToolClient(platform, flags.id, 'existing');
          await client.pullFile(args.path, localPath);
          if (flags.json) {
            this.outputJson({ localPath, bytes: fs.statSync(localPath).size });
          } else {
            this.output(localPath);
          }
        },
        { createReplacement: false },
      );
    }
  };
}
