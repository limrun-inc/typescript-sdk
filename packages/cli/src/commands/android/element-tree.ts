import { Flags } from '@oclif/core';
import type { AndroidElementTreeOptions } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  getAndroidInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

const MAX_WAIT_FOR_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 30_000;
const SERVER_EXECUTION_MARGIN_MS = 8_000;
const SDK_TRANSPORT_MARGIN_MS = 2_000;
const DAEMON_IPC_MARGIN_MS = 2_000;

export interface AndroidElementTreeInvocation {
  options?: AndroidElementTreeOptions;
  daemonArgs: unknown[];
  daemonTimeoutMs?: number;
}

export function buildAndroidElementTreeInvocation(
  waitForIdleTimeoutMs: number | undefined,
): AndroidElementTreeInvocation {
  if (
    waitForIdleTimeoutMs !== undefined &&
    (!Number.isFinite(waitForIdleTimeoutMs) ||
      !Number.isInteger(waitForIdleTimeoutMs) ||
      waitForIdleTimeoutMs < 0 ||
      waitForIdleTimeoutMs > MAX_WAIT_FOR_IDLE_TIMEOUT_MS)
  ) {
    throw new Error(
      `--wait-for-idle-timeout-ms must be a finite non-negative integer no greater than ${MAX_WAIT_FOR_IDLE_TIMEOUT_MS}.`,
    );
  }

  if (waitForIdleTimeoutMs === undefined) {
    return { daemonArgs: [] };
  }

  const options: AndroidElementTreeOptions = { waitForIdleTimeoutMs };
  return {
    options,
    daemonArgs: [options],
    daemonTimeoutMs:
      waitForIdleTimeoutMs === 0 ? undefined : (
        Math.max(
          DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
          waitForIdleTimeoutMs + SERVER_EXECUTION_MARGIN_MS + SDK_TRANSPORT_MARGIN_MS + DAEMON_IPC_MARGIN_MS,
        )
      ),
  };
}

export default class AndroidElementTree extends BaseCommand {
  static summary = 'Get the UI element tree from a running Android instance';
  static description =
    'Inspect the current UI hierarchy of a running Android instance. Use `--json` for structured output that agents can search or feed into later automation steps.';
  static examples = [
    '<%= config.bin %> android element-tree',
    '<%= config.bin %> android element-tree --id <instance-ID>',
    '<%= config.bin %> android element-tree --wait-for-idle-timeout-ms 5000',
    '<%= config.bin %> android element-tree --json',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to inspect. Defaults to the last created Android instance.',
    }),
    'wait-for-idle-timeout-ms': Flags.integer({
      description:
        'Wait up to this many milliseconds for Android UI automation to become idle (0-120000). Omit or use 0 for an immediate snapshot.',
      min: 0,
      max: MAX_WAIT_FOR_IDLE_TIMEOUT_MS,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidElementTree);
    this.setParsedFlags(flags);
    const invocation = buildAndroidElementTreeInvocation(flags['wait-for-idle-timeout-ms']);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('android element-tree only supports Android instances');
      }

      if (await ensureDaemonSession(resolvedInstance)) {
        const tree = await sendSessionCommand(
          id,
          'element-tree',
          invocation.daemonArgs,
          invocation.daemonTimeoutMs,
        );
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

      const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
      try {
        const tree = await client.getElementTree(invocation.options);
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
