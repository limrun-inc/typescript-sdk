import { Args, Flags } from '@oclif/core';
import { findBazelWorkspaceRoot } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { isProcessAlive, readRbePidFile } from '../../../lib/rbe-session';

export default class XcodeRbeUpload extends BaseCommand {
  static summary = 'Upload the latest successful remote build as an asset';
  static description =
    "Uploads the newest successful Bazel build of this workspace's running remote-execution " +
    'tunnel as a named asset, in the same artifact format `lim xcode build --upload` produces. ' +
    'Run it after `bazel build --config=limrun` succeeds. For uploads that happen automatically ' +
    'on every successful build, start the tunnel with `lim xcode rbe --auto-upload <name>` instead.';
  static examples = [
    '<%= config.bin %> xcode rbe upload preview/my-app',
    '<%= config.bin %> xcode rbe upload preview/my-app --ttl 24h',
  ];

  static args = {
    name: Args.string({
      description: 'Asset name to upload the build as.',
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    ttl: Flags.string({
      description: 'Asset TTL as a Go duration (e.g. 24h, 30m).',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeRbeUpload);
    this.setParsedFlags(flags);

    const workspaceRoot = findBazelWorkspaceRoot(process.cwd());
    if (!workspaceRoot) {
      this.error(
        'Not inside a Bazel workspace. Run `lim xcode rbe upload` from within the workspace ' +
          'whose build you want to upload.',
      );
    }
    // oclif's required-arg check accepts an empty string (e.g. an unset shell
    // variable), which would reach the server as asset name "".
    if (!args.name) {
      this.error('The asset name must not be empty.');
    }
    const info = readRbePidFile(workspaceRoot);
    if (!info || !isProcessAlive(info.pid)) {
      this.error(
        'No background tunnel for this workspace. Start one with `lim xcode rbe` and run ' +
          '`bazel build --config=limrun <target>` before uploading. (A foreground --no-daemon ' +
          'tunnel is not tracked here; use --auto-upload with it instead.)',
      );
    }

    await this.withAuth(async () => {
      const client = await this.resolveXcodeClient(await this.resolveXcodeTarget(info.instanceId));
      const result = await client.uploadLatestRbeBuild({
        assetName: args.name,
        ...(flags.ttl && { ttl: flags.ttl }),
      });
      if (this.isJsonEnabled()) {
        this.outputJson(result);
        return;
      }
      this.info(`Uploaded ${result.appName} as asset "${args.name}".`);
      if (result.signedDownloadUrl) {
        this.output(result.signedDownloadUrl);
      }
    });
  }
}
