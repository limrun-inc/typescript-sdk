import { Args } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { parseXcodeMajor, xcodeTargetFlags } from '../../../lib/xcode-version';

export default class XcodeVersionSet extends BaseCommand {
  static summary = 'Pick the Xcode version this workspace builds with';
  static description =
    'Remember an Xcode major for this workspace (the git repo, a `lim set-workspace-dir` assignment, or the global ' +
    'slot outside a repo) and switch the remembered sandbox to it now. Later builds, tests, RBE sessions and newly ' +
    'created sandboxes follow it; `--xcode-version` overrides it for one command. Switching invalidates the build cache from the other version (the next build starts cold) ' +
    'and is refused while the sandbox is busy.';

  static examples = [
    '<%= config.bin %> xcode version set 27',
    '<%= config.bin %> xcode version set 26 --id <xcode-instance-ID>',
  ];

  static args = {
    major: Args.string({ description: 'Xcode major to prefer, e.g. 27.', required: true }),
  };

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeVersionSet);
    this.setParsedFlags(flags);
    const major = parseXcodeMajor(args.major, 'version set');
    await this.setPreferredXcodeVersion(major, flags.id);
  }
}
