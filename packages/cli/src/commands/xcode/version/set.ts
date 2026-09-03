import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { loadLastXcodeInstance, setXcodeVersionPreference } from '../../../lib/config';
import { formatXcode, parseXcodeMajor } from '../../../lib/xcode-version';

export default class XcodeVersionSet extends BaseCommand {
  static summary = 'Pick the Xcode version this workspace builds with';
  static description =
    'Remember an Xcode major for this workspace (the git repo, a `lim set-workspace-dir` assignment, or the global ' +
    'slot outside a repo) and switch the remembered sandbox to it now. Later builds, tests, RBE sessions and newly ' +
    "created sandboxes follow it; `--xcode-version` overrides it for one command. Switching resets the sandbox's " +
    'DerivedData and is refused while it is busy.';

  static examples = [
    '<%= config.bin %> xcode version set 27',
    '<%= config.bin %> xcode version set 26 --id <xcode-instance-ID>',
  ];

  static args = {
    major: Args.string({ description: 'Xcode major to prefer, e.g. 27.', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description:
        'Xcode instance ID to switch now. Defaults to the most recently created Xcode-capable target.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeVersionSet);
    this.setParsedFlags(flags);
    const major = parseXcodeMajor(args.major, 'version set');
    // The preference is the workspace's wish and is recorded even when the sandbox refuses the
    // switch right now (busy, or a major it does not have); the next command retries it.
    setXcodeVersionPreference(major);
    this.info(`Xcode ${major} is now the preferred version${this.scopeSuffix()}.`);

    if (!flags.id && !loadLastXcodeInstance()) {
      if (flags.json) this.outputJson({ preferred: major });
      else this.output('No sandbox yet; the next one uses it.');
      return;
    }

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const xcodeClient = await this.resolveXcodeClient(target);
      const result = await this.selectXcode(xcodeClient, major);
      if (flags.json) {
        this.outputJson({ instanceId: target.id, preferred: major, ...result });
        return;
      }
      const verb = result.alreadyBound ? 'already uses' : 'now uses';
      this.output(`Sandbox ${target.id} ${verb} Xcode ${formatXcode(result.bound)}`);
      if (result.derivedDataReset) {
        this.output('DerivedData was reset; the next build starts cold.');
      }
    });
  }
}
