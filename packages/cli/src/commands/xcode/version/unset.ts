import { BaseCommand } from '../../../base-command';
import { clearXcodeVersionPreference, loadXcodeVersionPreference } from '../../../lib/config';
import { formatXcode, xcodeTargetFlags } from '../../../lib/xcode-version';

export default class XcodeVersionUnset extends BaseCommand {
  static summary = 'Forget the Xcode version preference of this workspace';
  static description =
    'Remove the preference set with `lim xcode version set` and put the remembered (or --id) sandbox back on ' +
    "its node's default Xcode. New sandboxes use the node default.";

  static examples = ['<%= config.bin %> xcode version unset'];

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeVersionUnset);
    this.setParsedFlags(flags);
    const previous = loadXcodeVersionPreference();
    clearXcodeVersionPreference();
    const forgotLine =
      previous ?
        `Forgot Xcode ${previous}${this.scopeSuffix()}.`
      : `No Xcode version preference${this.scopeSuffix()}.`;

    await this.withAuth(async () => {
      const target = await this.tryResolveXcodeTarget(flags.id);
      const status =
        target ?
          await this.readXcodeSelectionOrForget(target, async () =>
            (await this.resolveXcodeClient(target)).getXcode(),
          )
        : undefined;
      const nodeDefault = status?.installed.find((x) => x.nodeDefault);
      if (!target || !status || !nodeDefault) {
        if (flags.json) this.outputJson({ previous });
        else this.output(`${forgotLine} No sandbox instance found; the next one uses the node default.`);
        return;
      }
      if (status.bound.major === nodeDefault.major) {
        if (flags.json) this.outputJson({ previous, instanceId: target.id, bound: status.bound });
        else
          this.output(`${forgotLine} Sandbox ${target.id} already uses Xcode ${formatXcode(status.bound)}.`);
        return;
      }
      // Unset means "back to the default", so the sandbox follows the preference out; a busy
      // sandbox (409) keeps its Xcode and says so.
      let result;
      try {
        result = await (await this.resolveXcodeClient(target)).setXcode(nodeDefault.major);
      } catch (err) {
        const refusal = this.xcodeRefusal(err);
        if (!refusal) throw err;
        this.info(forgotLine);
        this.error(`${refusal.message}. Sandbox ${target.id} keeps Xcode ${formatXcode(status.bound)}.`);
      }
      if (flags.json) {
        this.outputJson({ previous, instanceId: target.id, ...result });
        return;
      }
      this.output(`${forgotLine} Sandbox ${target.id} now uses Xcode ${formatXcode(result.bound)}.`);
      if (result.derivedDataReset) {
        this.output('DerivedData was reset; the next build starts cold.');
      }
    });
  }
}
