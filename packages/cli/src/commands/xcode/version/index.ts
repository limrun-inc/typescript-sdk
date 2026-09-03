import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command';
import { loadLastXcodeInstance, loadXcodeVersionPreference } from '../../../lib/config';
import { formatXcode } from '../../../lib/xcode-version';

export default class XcodeVersion extends BaseCommand {
  static summary = 'Show the Xcode version the sandbox builds with';
  static description =
    'Print the Xcode the remembered (or --id) sandbox is bound to, and the version this workspace prefers when it ' +
    'differs. `lim xcode version set <major>` picks a version for the workspace, `lim xcode version list` shows ' +
    'the choices.';

  static examples = [
    '<%= config.bin %> xcode version',
    '<%= config.bin %> xcode version --id <xcode-instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    create: Flags.boolean({ hidden: true, default: false, allowNo: true }),
    id: Flags.string({
      description:
        'Xcode instance ID to inspect. Defaults to the most recently created Xcode-capable target.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(XcodeVersion);
    this.setParsedFlags(flags);
    const preferred = loadXcodeVersionPreference();

    if (!flags.id && !loadLastXcodeInstance()) {
      if (flags.json) {
        this.outputJson({ preferred });
      } else if (preferred) {
        this.output(`No sandbox yet; the next one uses Xcode ${preferred}${this.scopeSuffix()}.`);
      } else {
        this.output(`No sandbox yet and no preference${this.scopeSuffix()}; sandboxes use the node default.`);
      }
      return;
    }

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const status = await (await this.resolveXcodeClient(target)).getXcode();
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
