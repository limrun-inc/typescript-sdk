import { Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { parsePointFlag } from '../../lib/parse-point';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

const IPC_TIMEOUT_BUFFER_MS = 15_000;

export default class IosSwipe extends BaseCommand {
  static summary = 'Swipe between two points on a running iOS instance';
  static description =
    'Perform a touch drag gesture from one screen point to another, expressed in screen points. ' +
    'Use `ios scroll` for plain content scrolling; swipe gives explicit start/end points and duration ' +
    'for gestures that need them: pull-to-refresh from a specific area, carousel paging, sliders, and diagonal drags.';
  static examples = [
    '<%= config.bin %> ios swipe --from 200,300 --to 200,600',
    '<%= config.bin %> ios swipe --from 200,300 --to 200,600 --duration 800',
    '<%= config.bin %> ios swipe --from 350,400 --to 50,400 --id <instance-ID>',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
    from: Flags.string({
      description: 'Start point as "x,y" in screen points.',
      required: true,
    }),
    to: Flags.string({
      description: 'End point as "x,y" in screen points.',
      required: true,
    }),
    duration: Flags.integer({
      description: 'Gesture duration in milliseconds. Longer swipes drag more precisely; shorter ones fling.',
      default: 300,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IosSwipe);
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      const from = parsePointFlag(flags.from, '--from');
      const to = parsePointFlag(flags.to, '--to');
      const actions = swipeActions(from, to, flags.duration);
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      // One timeout governs the batch on both transports. The IPC socket
      // gets a buffer on top, so the real error surfaces before the socket
      // times out.
      const timeoutMs = flags.duration + IPC_TIMEOUT_BUFFER_MS;
      if (await ensureDaemonSession(resolvedInstance)) {
        try {
          await sendSessionCommand(
            id,
            'perform-actions',
            [actions, timeoutMs],
            timeoutMs + IPC_TIMEOUT_BUFFER_MS,
          );
        } catch (error) {
          await liftFinger((batch) => sendSessionCommand(id, 'perform-actions', [batch]), to);
          throw error;
        }
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.performActions(actions, { timeoutMs });
        } catch (error) {
          await liftFinger((batch) => client.performActions(batch), to);
          throw error;
        } finally {
          disconnect();
        }
      }
      this.log(`Swiped from (${from[0]}, ${from[1]}) to (${to[0]}, ${to[1]})`);
    });
  }
}

/**
 * Lifts the finger after a failed batch, best-effort. A failed batch stops
 * before its trailing touchUp, and a finger left pressed corrupts every
 * later gesture.
 */
async function liftFinger(
  send: (batch: Ios.PerformAction[]) => Promise<unknown>,
  to: [number, number],
): Promise<void> {
  try {
    await send([{ type: 'touchUp', x: to[0], y: to[1] }]);
  } catch {
    // The original error is the one worth surfacing.
  }
}

/**
 * Builds the swipe as touchDown, interpolated touchMoves, touchUp. Steps
 * are ~8ms apart (the touch sample rate); short swipes get fewer steps so
 * each one still moves.
 */
function swipeActions(from: [number, number], to: [number, number], durationMs: number): Ios.PerformAction[] {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const distance = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(2, Math.min(60, Math.round(durationMs / 8), Math.round(distance / 3)));
  const stepDelayMs = Math.max(1, Math.round(durationMs / steps));

  const actions: Ios.PerformAction[] = [{ type: 'touchDown', x: x0, y: y0 }];
  for (let i = 1; i <= steps; i++) {
    actions.push(
      { type: 'wait', durationMs: stepDelayMs },
      {
        type: 'touchMove',
        x: Math.round(x0 + ((x1 - x0) * i) / steps),
        y: Math.round(y0 + ((y1 - y0) * i) / steps),
      },
    );
  }
  actions.push({ type: 'touchUp', x: x1, y: y1 });
  return actions;
}
