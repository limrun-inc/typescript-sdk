import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosElementTree extends BaseCommand {
  static summary = 'Get the UI element tree from a running iOS instance';
  static description =
    'Inspect the current accessibility hierarchy of a running iOS instance. Use `--json` for structured output that agents can search or feed into later automation steps.';
  static examples = [
    '<%= config.bin %> ios element-tree',
    '<%= config.bin %> ios element-tree --id <instance-ID>',
    '<%= config.bin %> ios element-tree --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to inspect. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosElementTree);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios element-tree only supports iOS instances');
      }

      if (hasActiveSession(id)) {
        const tree = await sendSessionCommand(id, 'element-tree');
        if (flags.json) {
          this.outputJson(tree);
        } else {
          this.log(typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2));
        }
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'ios') {
          this.error('ios element-tree only supports iOS instances');
        }
        const tree = await (client as any).elementTree();
        if (flags.json) {
          this.outputJson(tree);
        } else {
          this.log(typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2));
        }
      } finally {
        disconnect();
      }
    });
  }
}
