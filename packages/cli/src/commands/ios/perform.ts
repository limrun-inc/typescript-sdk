import fs from 'fs';
import yaml from 'js-yaml';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command';
import {
  detectInstanceType,
  getInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

type PerformActionInput = {
  type: string;
  durationMs?: number;
  [key: string]: unknown;
};

type PerformActionsResult = {
  results: Array<Record<string, unknown>>;
};

const IPC_TIMEOUT_BUFFER_MS = 5_000;

function splitActionFields(raw: string): string[] {
  const fields: string[] = [];
  let current = '';
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === ',') {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }

  fields.push(current);
  return fields;
}

function parseScalarValue(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to plain string parsing if this is not valid JSON.
    }
  }

  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseAction(raw: string, index: number): PerformActionInput {
  const action: Record<string, unknown> = {};

  for (const field of splitActionFields(raw)) {
    const trimmed = field.trim();
    if (!trimmed) continue;

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      throw new Error(`Action ${index + 1} field "${trimmed}" must use key=value syntax`);
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1);
    if (!key) {
      throw new Error(`Action ${index + 1} contains an empty key`);
    }

    action[key] = parseScalarValue(value);
  }

  if (typeof action.type !== 'string' || action.type.length === 0) {
    throw new Error(`Action ${index + 1} must include type=<action-name>`);
  }

  return action as PerformActionInput;
}

function parseActionsDocument(raw: string, source: string): PerformActionInput[] {
  let parsed: unknown;

  try {
    parsed = yaml.load(raw);
  } catch (error) {
    throw new Error(`Failed to parse actions from ${source}: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Actions in ${source} must be an array`);
  }

  for (const [index, action] of parsed.entries()) {
    if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
      throw new Error(`Action at index ${index} in ${source} must be an object with a string "type" field`);
    }
  }

  return parsed as PerformActionInput[];
}

function parseActions(rawActions: string[]): PerformActionInput[] {
  if (rawActions.length === 0) {
    throw new Error('Provide at least one --action flag');
  }

  return rawActions.map((rawAction, index) => parseAction(rawAction, index));
}

async function readActions(flags: { action?: string[]; file?: string }): Promise<PerformActionInput[]> {
  const hasInlineActions = (flags.action?.length ?? 0) > 0;
  const hasFile = typeof flags.file === 'string';

  if (!hasInlineActions && !hasFile) {
    throw new Error('Provide either at least one --action flag or --file');
  }

  if (hasInlineActions && hasFile) {
    throw new Error('Use either --action or --file, not both');
  }

  if (hasInlineActions) {
    return parseActions(flags.action!);
  }

  const raw = await fs.promises.readFile(flags.file!, 'utf-8');
  return parseActionsDocument(raw, flags.file!);
}

function estimateTimeoutMs(actions: PerformActionInput[], overrideTimeoutMs?: number): number {
  if (overrideTimeoutMs !== undefined) {
    return overrideTimeoutMs;
  }

  const waitMs = actions.reduce((total, action) => {
    if (action.type !== 'wait' || typeof action.durationMs !== 'number') {
      return total;
    }

    return total + Math.max(0, action.durationMs);
  }, 0);

  return 30_000 + waitMs + actions.length * 2_000;
}

export default class IosPerform extends BaseCommand {
  static summary = 'Perform multiple iOS actions in a single batch';
  static description =
    'Run a batch of iOS actions in a single CLI invocation using repeated `--action` flags or a JSON/YAML action file. This is the best choice for agent-driven multi-step interactions that should execute without reconnecting between steps.';
  static examples = [
    '<%= config.bin %> ios perform --action type=tap,x=100,y=200 --action "type=typeText,text=Hello World"',
    '<%= config.bin %> ios perform --action type=wait,durationMs=1000 --action type=pressKey,key=enter',
    '<%= config.bin %> ios perform --file ./actions.yaml',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    action: Flags.string({
      description: `Action definition as comma-separated key=value pairs; repeat for multiple actions.

Available action types:
- Tap on coordinate: type=tap,x=100,y=200
- Tap on element by using a selector: type=tapElement,selector={"AXLabel":"Submit"}
- Increment an element by using a selector: type=incrementElement,selector={"AXLabel":"Volume"}
- Decrement an element by using a selector: type=decrementElement,selector={"AXLabel":"Volume"}
- Set an element value by using a selector: type=setElementValue,text=42,selector={"AXLabel":"Counter"}
- Type text into the focused field: type=typeText,text=Hello World,pressEnter=true
- Press a key with optional modifiers: type=pressKey,key=a,modifiers=["shift"]
- Scroll the screen: type=scroll,direction=down,pixels=300,coordinate=[200,400],momentum=0.2
- Toggle the software keyboard: type=toggleKeyboard
- Open a URL or deep link: type=openUrl,url=https://example.com
- Set device orientation: type=setOrientation,orientation=Landscape
- Wait before the next action: type=wait,durationMs=1000
- Start a touch gesture: type=touchDown,x=100,y=200
- Move a touch gesture: type=touchMove,x=120,y=220
- End a touch gesture: type=touchUp,x=120,y=220
- Press a raw key code down: type=keyDown,keyCode=4
- Release a raw key code: type=keyUp,keyCode=4
- Press a hardware button down: type=buttonDown,button=home
- Release a hardware button: type=buttonUp,button=home

Use JSON values for complex fields like selector, modifiers, and coordinate.`,
      multiple: true,
    }),
    file: Flags.string({
      char: 'f',
      description: `Path to a YAML or JSON file containing an array of action objects.

JSON example:
[
  { "type": "tap", "x": 100, "y": 200 },
  { "type": "typeText", "text": "Hello World" }
]

YAML example:
- type: tap
  x: 100
  y: 200
- type: typeText
  text: "Hello World"`,
    }),
    timeout: Flags.integer({
      description:
        'Override the total batch timeout in milliseconds. By default the CLI grows the timeout based on waits and action count.',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosPerform);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const id = this.resolveId(flags.id);
      if (detectInstanceType(id) !== 'ios') {
        this.error('ios perform only supports iOS instances');
      }

      const actions = await readActions(flags);
      const timeoutMs = estimateTimeoutMs(actions, flags.timeout);
      const ipcTimeoutMs = timeoutMs + IPC_TIMEOUT_BUFFER_MS;

      let result: PerformActionsResult;
      if (hasActiveSession(id)) {
        result = (await sendSessionCommand(
          id,
          'perform-actions',
          [actions, flags.timeout],
          ipcTimeoutMs,
        )) as PerformActionsResult;
      } else {
        const { type, client, disconnect } = await getInstanceClient(this.client, id);
        try {
          if (type !== 'ios') {
            this.error('ios perform only supports iOS instances');
          }
          result = (await (client as any).performActions(
            actions,
            flags.timeout !== undefined ? { timeoutMs: flags.timeout } : undefined,
          )) as PerformActionsResult;
        } finally {
          disconnect();
        }
      }

      if (flags.json) {
        this.outputJson(result);
      } else {
        this.log(`Performed ${result.results.length} action${result.results.length === 1 ? '' : 's'}`);
      }
    });
  }
}
