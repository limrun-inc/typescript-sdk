import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { getInstanceClient, hasActiveSession, sendSessionCommand } from '../../lib/instance-client-factory';

export default class ExecElementTree extends BaseCommand {
  static summary = 'Get the UI element tree from a running instance';
  static aliases = ['ios element-tree', 'android element-tree'];
  static examples = [
    '<%= config.bin %> ios element-tree',
    '<%= config.bin %> ios element-tree --id <instance-ID>',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({ description: 'Instance ID (defaults to last created)' }),
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
