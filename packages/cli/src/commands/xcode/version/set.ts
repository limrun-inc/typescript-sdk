import { Args } from '@oclif/core';
import type { XcodeSelectResult } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import {
  clearXcodeVersionPreference,
  loadXcodeVersionPreference,
  setXcodeVersionPreference,
} from '../../../lib/config';
import { formatXcode, parseXcodeMajor, xcodeTargetFlags } from '../../../lib/xcode-version';

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

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(XcodeVersionSet);
    this.setParsedFlags(flags);
    const major = parseXcodeMajor(args.major, 'version set');
    const previous = loadXcodeVersionPreference();
    // Recorded up front: a busy sandbox (409) refuses the switch right now and the next
    // command retries it. Only a major the node does not offer (400) rolls it back below,
    // because a preference for it would make every later command fail the same way.
    setXcodeVersionPreference(major);
    const preferredLine = `Xcode ${major} is now the preferred version${this.scopeSuffix()}.`;

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
        if (!refusal) throw err;
        if (refusal.status === 400) {
          if (previous) setXcodeVersionPreference(previous);
          else clearXcodeVersionPreference();
          this.error(
            `${refusal.message}. The workspace preference stays ${previous ? `Xcode ${previous}` : 'unset'}.`,
          );
        }
        this.info(preferredLine);
        this.error(`${refusal.message}. The next command switches the sandbox.`);
      }
      if (flags.json) {
        // A vanished sandbox was forgotten above: naming its id here would present it as live.
        this.outputJson(
          result ? { instanceId: target?.id, preferred: major, ...result } : { preferred: major },
        );
        return;
      }
      this.info(preferredLine);
      if (!target || !result) {
        this.output('No sandbox instance found; the next one uses it.');
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
