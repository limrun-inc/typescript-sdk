import { BaseCommand } from '../../../base-command';
import { clearXcodeVersionPreference, loadXcodeVersionPreference } from '../../../lib/config';

export default class XcodeVersionUnset extends BaseCommand {
  static summary = 'Forget the Xcode version preference of this workspace';
  static description =
    'Remove the preference set with `lim xcode version set`. Sandboxes keep the Xcode they are bound to; new ' +
    'sandboxes use the node default.';

  static examples = ['<%= config.bin %> xcode version unset'];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeVersionUnset);
    this.setParsedFlags(flags);
    const previous = loadXcodeVersionPreference();
    clearXcodeVersionPreference();
    if (flags.json) {
      this.outputJson({ previous });
      return;
    }
    if (previous) {
      this.output(`Forgot Xcode ${previous}${this.scopeSuffix()}; sandboxes keep their current Xcode.`);
    } else {
      this.output(`No Xcode version preference${this.scopeSuffix()}.`);
    }
  }
}
