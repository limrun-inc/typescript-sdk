import { Args } from '@oclif/core';
import type { XcodeSelectResult } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { loadXcodeVersionPreference, setXcodeVersionPreference } from '../../../lib/config';
import { formatXcode, parseXcodeMajor, xcodeTargetFlags } from '../../../lib/xcode-version';

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
    const previous = loadXcodeVersionPreference();
    // The preference is the workspace's wish and is recorded whatever the sandbox answers, except
    // a 400: a major the node does not offer would make every later command fail the same way.
    const record = () => {
      setXcodeVersionPreference(major);
      this.info(`Xcode ${major} is now the preferred version${this.scopeSuffix()}.`);
    };

    await this.withAuth(async () => {
      const target = await this.tryResolveXcodeTarget(flags.id);
      let result: XcodeSelectResult | undefined;
      try {
        result =
          target ?
            await this.readXcodeSelectionOrForget(target, async () =>
              (await this.resolveXcodeClient(target)).setXcode(major),
            )
          : undefined;
      } catch (err) {
        const refusal = this.xcodeRefusal(err);
        if (refusal?.status === 400) {
          if (previous === major) {
            this.error(
              `${refusal.message}. This workspace already prefers Xcode ${major}; drop it with: lim xcode version unset`,
            );
          }
          this.error(
            `${refusal.message}. The workspace preference stays ${previous ? `Xcode ${previous}` : 'unset'}.`,
          );
        }
        record();
        if (refusal) this.error(`${refusal.message}. The next command switches the sandbox.`);
        throw err;
      }
      record();
      if (!target || !result) {
        if (flags.json) this.outputJson({ preferred: major });
        else this.output(`No sandbox instance found${this.scopeSuffix()}; the next one uses it.`);
        return;
      }
      if (flags.json) {
        this.outputJson({ instanceId: target.id, preferred: major, ...result });
        return;
      }
      const verb = result.alreadyBound ? 'already uses' : 'now uses';
      this.output(`Sandbox ${target.id} ${verb} Xcode ${formatXcode(result.bound)}`);
      if (result.derivedDataReset) {
        this.output('The build cache from the previous Xcode is invalidated; the next build starts cold.');
      }
    });
  }
}
