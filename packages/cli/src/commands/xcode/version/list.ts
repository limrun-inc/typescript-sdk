import { BaseCommand } from '../../../base-command';
import {
  formatXcodeVersion,
  xcodeSelectorFor,
  xcodeTargetFlags,
  type XcodeInfoWithChannel,
} from '../../../lib/xcode-version';
import { loadXcodeVersionPreference } from '../../../lib/config';

export default class XcodeVersionList extends BaseCommand {
  static summary = 'List the Xcode versions the sandbox can build with';
  static description =
    "Show the Xcodes installed on the sandbox's node, which one is selected, the node default, and the version " +
    'this workspace prefers. Pick one with `lim xcode version set <version>`: the Select column is the value to ' +
    'pass, a bare major for the GA release of that major and a major.minor for a beta.';

  static examples = [
    '<%= config.bin %> xcode version list',
    '<%= config.bin %> xcode version list --id <xcode-instance-ID>',
  ];

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeVersionList);
    this.setParsedFlags(flags);
    const preferred = loadXcodeVersionPreference();

    await this.withAuth(async () => {
      const read = await this.tryReadXcodeStatus(flags.id);
      if (!read) {
        if (flags.json) this.outputJson({ preferred, installed: [] });
        else
          this.output(
            `No sandbox instance found${this.scopeSuffix()}; create one with \`lim xcode create\` and run \`lim xcode version list\` again.`,
          );
        return;
      }
      const { target, status } = read;
      if (flags.json) {
        this.outputJson({ instanceId: target.id, ...status, preferred });
        return;
      }
      const installed = status.installed as XcodeInfoWithChannel[];
      if (this.isQuietEnabled()) {
        for (const x of installed) this.output(xcodeSelectorFor(x, installed));
        return;
      }
      // Two Xcodes of one major share it, so the bound mark goes by the bundle, not the major.
      const rows = installed.map((x) => [
        x.developerDir === status.bound.developerDir ? '*' : '',
        xcodeSelectorFor(x, installed),
        x.channel ?? '',
        formatXcodeVersion(x),
      ]);
      this.outputTable(['', 'Select', 'Channel', 'Version'], rows);
    });
  }
}
