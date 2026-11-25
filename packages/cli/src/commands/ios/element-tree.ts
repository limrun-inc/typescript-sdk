import { Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosElementTree extends BaseCommand {
  static summary = 'Get the UI element tree from a running iOS instance';
  static description =
    'Inspect the current accessibility hierarchy of a running iOS instance. Use `--json` for structured output that agents can search or feed into later automation steps. Use `--source xcuitest` for the tree XCUITest sees, where navigation bars, tab bars, the keyboard and alerts are containers with their children.';
  static examples = [
    '<%= config.bin %> ios element-tree',
    '<%= config.bin %> ios element-tree --id <instance-ID>',
    '<%= config.bin %> ios element-tree --json',
    '<%= config.bin %> ios element-tree --source xcuitest --json',
    '<%= config.bin %> ios element-tree --wait-for-idle-timeout-ms 3000',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    'visible-only': Flags.boolean({
      description: 'Skip offscreen branches while reading the tree. The default reads the full tree.',
      default: false,
    }),
    source: Flags.string({
      description:
        'Which reader answers: accessibility (the default) or xcuitest, the snapshot XCUITest queries. xcuitest takes about a second and reads the whole tree.',
      options: ['accessibility', 'xcuitest'],
    }),
    'wait-for-idle-timeout-ms': Flags.integer({
      description:
        'Wait up to this many milliseconds for the screen to settle before reading. Warns on stderr when it does not.',
      min: 0,
      max: 30_000,
    }),
    id: Flags.string({
      description: 'iOS instance ID to inspect. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosElementTree);
    this.setParsedFlags(flags);
    const waitForIdleTimeoutMs = flags['wait-for-idle-timeout-ms'];
    const options: Ios.ElementTreeOptions = {
      visibleOnly: flags['visible-only'],
      ...(flags.source ? { source: flags.source as Ios.ElementTreeSource } : {}),
      ...(waitForIdleTimeoutMs !== undefined ? { waitForIdleTimeoutMs } : {}),
    };
    const timeoutMs = 30_000 + (waitForIdleTimeoutMs ?? 0);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      let read: Ios.ElementTreeRead;
      if (await ensureDaemonSession(resolvedInstance)) {
        read = await readThroughDaemon(id, options, timeoutMs);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          read = await client.readElementTree(undefined, options);
        } finally {
          disconnect();
        }
      }

      if (read.idle === false) {
        this.warn(
          `The screen was still changing after ${waitForIdleTimeoutMs} ms; the tree may be mid-change.`,
        );
      }
      if (flags.json) {
        this.outputJson(read.tree);
      } else {
        this.log(JSON.stringify(read.tree, null, 2));
      }
    });
  }
}

/**
 * Reads through the session daemon. A daemon started by an older CLI knows only element-tree,
 * which answers with the bare tree.
 */
async function readThroughDaemon(
  id: string,
  options: Ios.ElementTreeOptions,
  timeoutMs: number,
): Promise<Ios.ElementTreeRead> {
  try {
    return (await sendSessionCommand(id, 'read-element-tree', [options], timeoutMs)) as Ios.ElementTreeRead;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Unknown command')) throw error;
    const tree = await sendSessionCommand(id, 'element-tree', [options], timeoutMs);
    return { tree: (typeof tree === 'string' ? JSON.parse(tree) : tree) as Ios.ElementTree };
  }
}
