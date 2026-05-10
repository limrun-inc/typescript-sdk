import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import { androidSelectorFlags, buildAndroidSelector } from '../../lib/android-selector';
import {
  getAndroidInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

type AndroidNode = {
  text?: string;
  resourceId?: string;
  className?: string;
  contentDesc?: string;
  bounds?: string;
};

type FindElementResult = {
  elements: AndroidNode[];
  count: number;
};

export default class AndroidFindElement extends BaseCommand {
  static summary = 'Find Android elements by selector';
  static description =
    'Search the current Android UI hierarchy using native selector fields and return the matching elements without tapping them.';
  static examples = [
    '<%= config.bin %> android find-element --resource-id com.example:id/submit',
    '<%= config.bin %> android find-element --text "Sign In" --limit 5 --json',
    '<%= config.bin %> android find-element --content-desc "Settings" --id <instance-ID>',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to inspect. Defaults to the last created Android instance.',
    }),
    ...androidSelectorFlags,
    limit: Flags.integer({
      description: 'Maximum number of matching elements to return.',
      default: 20,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidFindElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveAndroidInstance(flags.id);
      const id = resolvedInstance.id;
      if (false) {
        this.error('android find-element only supports Android instances');
      }

      const selector = buildAndroidSelector(flags);
      if (!selector) {
        this.error(
          'Provide at least one Android selector flag such as --resource-id, --text, --content-desc, or --class-name.',
        );
      }

      let result: FindElementResult;
      if (hasActiveSession(id)) {
        result = (await sendSessionCommand(id, 'find-element', [selector, flags.limit])) as FindElementResult;
      } else {
        const { client, disconnect } = await getAndroidInstanceClient(this.client, resolvedInstance);
        try {
          result = await client.findElement(selector, flags.limit);
        } finally {
          disconnect();
        }
      }

      if (flags.json) {
        this.outputJson(result);
        return;
      }

      const rows = result.elements.map((element) => [
        element.text || '',
        element.resourceId || '',
        element.className || '',
        element.contentDesc || '',
        element.bounds || '',
      ]);
      this.outputTable(['Text', 'Resource ID', 'Class', 'Content Description', 'Bounds'], rows);
      this.output(`Matched ${result.count} element(s).`);
    });
  }
}
