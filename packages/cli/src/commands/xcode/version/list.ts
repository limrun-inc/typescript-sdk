import { BaseCommand } from '../../../base-command';
import { xcodeNotes, xcodeTargetFlags } from '../../../lib/xcode-version';
import { loadXcodeVersionPreference } from '../../../lib/config';

export default class XcodeVersionList extends BaseCommand {
  static summary = 'List the Xcode versions the sandbox can build with';
  static description =
    "Show the Xcodes installed on the sandbox's node, which one is selected, the node default, and the version " +
    'this workspace prefers. Pick one with `lim xcode version set <major>`.';

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
      const target = await this.tryResolveXcodeTarget(flags.id);
      const status =
        target ?
          (await this.tryReadXcodeStatus(target, this.isRememberedXcodeTarget(flags.id)))?.status
        : undefined;
      if (!target || !status) {
        if (flags.json) this.outputJson({ preferred, installed: [] });
        else
          this.output(
            `No sandbox instance found${this.scopeSuffix()}; create one with \`lim xcode create\` to see the Xcodes its node offers.`,
          );
        return;
      }
      if (flags.json) {
        this.outputJson({ instanceId: target.id, ...status, preferred });
        return;
      }
      if (this.isQuietEnabled()) {
        for (const x of status.installed) this.output(x.major);
        return;
      }
      const rows = status.installed.map((x) => [
        x.major,
        `${x.version} (${x.build})`,
        xcodeNotes(x, status.bound.major, preferred ?? undefined),
      ]);
      this.outputTable(['Major', 'Version', 'Notes'], rows);
    });
  }
}
