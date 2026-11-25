import { Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosFocusedElement extends BaseCommand {
  static summary = 'Show the element typed text would go to on a running iOS instance';
  static description =
    'Read the element that has focus, and the software keyboard. iOS leaves elements the keyboard covers out of the accessibility tree, so a keyboard with no element means the focused input is under the keyboard: `ios type` still reaches it.';
  static examples = [
    '<%= config.bin %> ios focused-element',
    '<%= config.bin %> ios focused-element --id <instance-ID> --json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to inspect. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosFocusedElement);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      let focus: Ios.FocusedElement;
      if (await ensureDaemonSession(resolvedInstance)) {
        focus = (await sendSessionCommand(id, 'focused-element')) as Ios.FocusedElement;
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          focus = await client.focusedElement();
        } finally {
          disconnect();
        }
      }

      this.outputResult({ instanceId: id, ...focus }, describe(focus));
    });
  }
}

function describe(focus: Ios.FocusedElement): string {
  if (focus.element) return JSON.stringify(focus.element, null, 2);
  if (focus.keyboard) {
    const { x, y, width, height } = focus.keyboard.frame;
    return `The focused input is under the software keyboard at ${Math.round(x)},${Math.round(
      y,
    )} ${Math.round(width)}x${Math.round(height)}. ios type still reaches it; ios set-text cannot.`;
  }
  return 'No element has focus.';
}
