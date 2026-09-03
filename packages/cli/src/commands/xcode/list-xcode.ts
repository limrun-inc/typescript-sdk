import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { renderTable } from '../../lib/formatting';

export default class XcodeListXcode extends BaseCommand {
  static summary = 'List the Xcode versions an Xcode instance can build with';
  static description =
    "Show the Xcodes installed on the sandbox's node and which one it is bound to. Switch with " +
    '`lim xcode set-xcode <major>` or `--xcode-version <major>` on build, test, rbe and create.';

  static examples = [
    '<%= config.bin %> xcode list-xcode',
    '<%= config.bin %> xcode list-xcode --id <xcode-instance-ID>',
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
    const { flags } = await this.parse(XcodeListXcode);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const target = await this.resolveXcodeTarget(flags.id);
      const status = await (await this.resolveXcodeClient(target)).getXcode();
      if (flags.json) {
        this.outputJson({ instanceId: target.id, ...status });
        return;
      }
      if (this.isQuietEnabled()) {
        for (const x of status.installed) this.output(x.major);
        return;
      }
      const rows = status.installed.map((x) => [
        x.major,
        `${x.version} (${x.build})`,
        [x.major === status.bound.major ? 'bound' : '', x.nodeDefault ? 'default' : '']
          .filter(Boolean)
          .join(', '),
      ]);
      this.output(renderTable(['MAJOR', 'VERSION', ''], rows));
    });
  }
}
