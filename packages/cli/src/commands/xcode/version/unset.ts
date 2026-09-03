import type { XcodeSelectResult } from '@limrun/api';
import { BaseCommand } from '../../../base-command';
import { clearXcodeVersionPreference, loadXcodeVersionPreference } from '../../../lib/config';
import { formatXcode, xcodeTargetFlags } from '../../../lib/xcode-version';

export default class XcodeVersionUnset extends BaseCommand {
  static summary = 'Forget the Xcode version preference of this workspace';
  static description =
    'Remove the preference set with `lim xcode version set` and put the remembered (or --id) sandbox back on ' +
    "its node's default Xcode. New sandboxes use the node default.";

  static examples = [
    '<%= config.bin %> xcode version unset',
    '<%= config.bin %> xcode version unset --id <xcode-instance-ID>',
  ];

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeVersionUnset);
    this.setParsedFlags(flags);
    const previous = loadXcodeVersionPreference();
    clearXcodeVersionPreference();
    // The local part is done and said before anything that can fail over the network.
    if (!flags.json) {
      this.output(
        previous ?
          `Forgot Xcode ${previous}${this.scopeSuffix()}.`
        : `No Xcode version preference${this.scopeSuffix()}.`,
      );
    }

    await this.withAuth(async () => {
      const target = await this.tryResolveXcodeTarget(flags.id);
      const remembered = this.isRememberedXcodeTarget(flags.id);
      const read = target ? await this.tryReadXcodeStatus(target, remembered) : undefined;
      const nodeDefault = read?.status.installed.find((x) => x.nodeDefault);
      if (!target || !read || !nodeDefault) {
        if (flags.json) this.outputJson({ previous });
        else this.output('No sandbox instance found; the next one uses the node default.');
        return;
      }
      if (read.status.bound.major === nodeDefault.major) {
        if (flags.json) this.outputJson({ previous, instanceId: target.id, bound: read.status.bound });
        else this.output(`Sandbox ${target.id} already uses Xcode ${formatXcode(read.status.bound)}.`);
        return;
      }
      // Unset means "back to the default", so the sandbox follows the preference out; a busy
      // sandbox (409) keeps its Xcode and says so.
      let result: XcodeSelectResult | undefined;
      try {
        result = await this.readXcodeSelectionOrForget(target, remembered, () =>
          read.client.setXcode(nodeDefault.major),
        );
      } catch (err) {
        const refusal = this.xcodeRefusal(err);
        if (!refusal) throw err;
        if (flags.json) {
          this.outputJson({
            previous,
            instanceId: target.id,
            bound: read.status.bound,
            error: refusal.message,
          });
        }
        this.error(`${refusal.message}. Sandbox ${target.id} keeps Xcode ${formatXcode(read.status.bound)}.`);
      }
      if (flags.json) {
        this.outputJson(result ? { previous, instanceId: target.id, ...result } : { previous });
        return;
      }
      if (!result) {
        this.output('No sandbox instance found; the next one uses the node default.');
        return;
      }
      this.output(`Sandbox ${target.id} now uses Xcode ${formatXcode(result.bound)}.`);
      if (result.derivedDataReset) {
        this.output('DerivedData was reset; the next build starts cold.');
      }
    });
  }
}
