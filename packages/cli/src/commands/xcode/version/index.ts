import { BaseCommand } from '../../../base-command';
import { loadXcodeVersionPreference } from '../../../lib/config';
import { formatXcode, xcodeTargetFlags } from '../../../lib/xcode-version';

export default class XcodeVersion extends BaseCommand {
  static summary = 'Show the Xcode version the sandbox builds with';
  static description =
    'Print the Xcode the remembered (or --id) sandbox has selected, and the version this workspace prefers when it ' +
    'differs. `lim xcode version set <major>` picks a version for the workspace, `lim xcode version list` shows ' +
    'the choices.';

  static examples = [
    '<%= config.bin %> xcode version',
    '<%= config.bin %> xcode version --id <xcode-instance-ID>',
  ];

  static flags = { ...BaseCommand.baseFlags, ...xcodeTargetFlags };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeVersion);
    this.setParsedFlags(flags);
    const preferred = loadXcodeVersionPreference();

    await this.withAuth(async () => {
      const target = await this.tryResolveXcodeTarget(flags.id);
      const status =
        target ?
          await this.readXcodeSelectionOrForget(target, async () =>
            (await this.resolveXcodeClient(target)).getXcode(),
          )
        : undefined;
      if (!target || !status) {
        if (flags.json) {
          this.outputJson({ preferred });
        } else if (preferred) {
          this.output(
            `No sandbox instance found; the next one uses Xcode ${preferred}${this.scopeSuffix()}.`,
          );
        } else {
          this.output(
            `No sandbox instance found and no preference${this.scopeSuffix()}; sandboxes use the node default.`,
          );
        }
        return;
      }
      if (flags.json) {
        this.outputJson({ instanceId: target.id, bound: status.bound, preferred });
        return;
      }
      if (this.isQuietEnabled()) {
        this.output(status.bound.major);
        return;
      }
      this.output(formatXcode(status.bound));
      if (preferred && preferred !== status.bound.major) {
        this.output(`This workspace prefers Xcode ${preferred}; the next build switches the sandbox to it.`);
      }
    });
  }
}
