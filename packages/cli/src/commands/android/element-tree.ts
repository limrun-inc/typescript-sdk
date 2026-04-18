import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidElementTree extends BaseCommand {
  static summary = 'Get the UI element tree from a running Android instance';
  static description =
    'Inspect the current UI hierarchy of a running Android instance. Use `--json` for structured output that agents can search or feed into later automation steps.';
  static examples = [
    '<%= config.bin %> android element-tree',
    '<%= config.bin %> android element-tree --id <instance-ID>',
    '<%= config.bin %> android element-tree --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to inspect. Defaults to the last created Android instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidElementTree);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android element-tree only supports Android instances');
      }

      if (hasActiveSession(id)) {
        const tree = await sendSessionCommand(id, 'element-tree');
        if (flags.json) {
          this.outputJson(tree);
        } else if (typeof tree === 'object' && tree && 'xml' in (tree as Record<string, unknown>)) {
          this.log(
            (tree as { xml?: string }).xml || JSON.stringify((tree as { nodes?: unknown }).nodes, null, 2),
          );
        } else {
          this.log(JSON.stringify(tree, null, 2));
        }
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'android') {
          this.error('android element-tree only supports Android instances');
        }
        const tree = await (client as any).getElementTree();
        if (flags.json) {
          this.outputJson(tree);
        } else {
          this.log(tree.xml || JSON.stringify(tree.nodes, null, 2));
        }
      } finally {
        disconnect();
      }
    });
  }
}
