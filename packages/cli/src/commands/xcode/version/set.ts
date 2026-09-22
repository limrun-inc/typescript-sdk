import { Args } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { parseXcodeVersion, xcodeTargetFlags } from '../../../lib/xcode-version';

export default class XcodeVersionSet extends BaseCommand {
  static summary = 'Pick the Xcode version this workspace builds with';
  static description =
    'Remember an Xcode version for this workspace (the git repo, a `lim set-workspace-dir` assignment, or the global ' +
    "slot outside a repo) and switch the remembered sandbox to it now. A bare major such as 27 selects that major's " +
    'GA release and follows it across point releases; a major.minor such as 27.1 pins that exact version, typically ' +
    'a beta, until the fleet retires it. Later builds, tests, RBE sessions and newly created sandboxes follow the ' +
    'preference; `--xcode-version` overrides it for one command. Switching invalidates the build cache from the ' +
    'other version (the next build starts cold) and is refused while the sandbox is busy.';

  static examples = [
    '<%= config.bin %> xcode version set 27',
    '<%= config.bin %> xcode version set 27.1',
    '<%= config.bin %> xcode version set 26 --id <xcode-instance-ID>',
  ];

  static args = {
    version: Args.string({
      description: 'Xcode to prefer: a major such as 27 (the GA) or a major.minor such as 27.1.',
      required: true,
    }),
  };

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeVersionSet);
    this.setParsedFlags(flags);
    const version = parseXcodeVersion(args.version, 'version set');
    await this.setPreferredXcodeVersion(version, flags.id);
  }
}
