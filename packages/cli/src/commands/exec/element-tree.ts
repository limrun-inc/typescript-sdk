import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecElementTree extends BaseCommand {
  static summary = 'Get the UI element tree from a running instance';
  static description =
    'Inspect the current accessibility hierarchy of a running iOS or Android instance. Use `--json` for structured output that agents can search, filter, or feed into later automation steps.';
  static examples = [
    '<%= config.bin %> ios element-tree',
    '<%= config.bin %> android element-tree --id <instance-ID>',
    '<%= config.bin %> ios element-tree --id <instance-ID>',
    '<%= config.bin %> ios element-tree --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Instance ID to inspect. Defaults to the last created instance of the command alias type.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ExecElementTree);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (hasActiveSession(id)) {
        const tree = await sendSessionCommand(id, 'element-tree');
        if (flags.json) {
          this.outputJson(tree);
        } else {
          this.log(typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2));
        }
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type === 'ios') {
            const tree = await (client as any).elementTree();
            this.log(typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2));
          } else {
            const tree = await (client as any).getElementTree();
            if (flags.json) {
              this.outputJson(tree);
            } else {
              this.log(tree.xml || JSON.stringify(tree.nodes, null, 2));
            }
          }
        } finally {
          disconnect();
        }
      }
    });
  }
}
