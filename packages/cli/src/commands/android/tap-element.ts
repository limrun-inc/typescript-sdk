import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class AndroidTapElement extends BaseCommand {
  static summary = 'Tap an Android element by selector';
  static description =
    'Find an element on the current Android screen and tap it using the native Android selector fields.';
  static examples = [
    '<%= config.bin %> android tap-element --resource-id com.example:id/submit',
    '<%= config.bin %> android tap-element --text "Sign In"',
    '<%= config.bin %> android tap-element --content-desc "Submit button"',
    '<%= config.bin %> android tap-element --class-name android.widget.Button --enabled',
  ];

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'Android instance ID to target. Defaults to the last created Android instance.',
    }),
    'resource-id': Flags.string({
      description: 'Match by `resourceId`, such as com.example:id/submit.',
    }),
    text: Flags.string({ description: 'Match by visible `text` using an exact match.' }),
    'content-desc': Flags.string({
      description: 'Match by `contentDesc` using an exact match.',
    }),
    'class-name': Flags.string({
      description: 'Match by `className`, such as android.widget.Button.',
    }),
    'package-name': Flags.string({
      description: 'Match by `packageName`, such as com.example.app.',
    }),
    index: Flags.integer({
      description: 'Match by child `index`.',
    }),
    clickable: Flags.boolean({
      description: 'Match by `clickable=true` or `clickable=false`.',
      allowNo: true,
    }),
    enabled: Flags.boolean({
      description: 'Match by `enabled=true` or `enabled=false`.',
      allowNo: true,
    }),
    focused: Flags.boolean({
      description: 'Match by `focused=true` or `focused=false`.',
      allowNo: true,
    }),
    'bounds-contains-x': Flags.integer({
      description: 'Match by `boundsContains.x`. Use together with `--bounds-contains-y`.',
    }),
    'bounds-contains-y': Flags.integer({
      description: 'Match by `boundsContains.y`. Use together with `--bounds-contains-x`.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AndroidTapElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'android') {
        this.error('android tap-element only supports Android instances');
      }

      const selector: Record<string, string | number | boolean | { x: number; y: number }> = {};
      if (flags['resource-id']) selector.resourceId = flags['resource-id'];
      if (flags.text) selector.text = flags.text;
      if (flags['content-desc']) selector.contentDesc = flags['content-desc'];
      if (flags['class-name']) selector.className = flags['class-name'];
      if (flags['package-name']) selector.packageName = flags['package-name'];
      if (flags.index !== undefined) selector.index = flags.index;
      if (flags.clickable !== undefined) selector.clickable = flags.clickable;
      if (flags.enabled !== undefined) selector.enabled = flags.enabled;
      if (flags.focused !== undefined) selector.focused = flags.focused;

      const hasBoundsX = flags['bounds-contains-x'] !== undefined;
      const hasBoundsY = flags['bounds-contains-y'] !== undefined;
      if (hasBoundsX !== hasBoundsY) {
        this.error('Use both --bounds-contains-x and --bounds-contains-y together.');
      }
      if (hasBoundsX && hasBoundsY) {
        selector.boundsContains = {
          x: flags['bounds-contains-x']!,
          y: flags['bounds-contains-y']!,
        };
      }

      if (Object.keys(selector).length === 0) {
        this.error(
          'Provide at least one Android selector flag such as --resource-id, --text, --content-desc, or --class-name.',
        );
      }

      if (hasActiveSession(id)) {
        const result = await sendSessionCommand(id, 'tap-element', [selector]);
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
        return;
      }

      const { type, client, disconnect } = await getInstanceClient(this.client, id);
      try {
        if (type !== 'android') {
          this.error('android tap-element only supports Android instances');
        }
        const result = await (client as any).tap({ selector });
        if (flags.json) this.outputJson(result);
        else this.log('Element tapped');
      } finally {
        disconnect();
      }
    });
  }
}
