import { Flags } from '@oclif/core';
import type { Ios } from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { parsePointFlag } from '../../lib/parse-point';
import {
  getIosInstanceClient,
  hasActiveSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

export default class IosSwipe extends BaseCommand {
  static summary = 'Swipe between two points on a running iOS instance';
  static description =
    'Perform a touch swipe gesture from one screen point to another, expressed in screen points. ' +
    'Useful for gestures scroll cannot express, like pull-to-refresh (swipe down from the upper third of the screen).';
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

    const from = parsePointFlag(flags.from, '--from');
    const to = parsePointFlag(flags.to, '--to');
    const actions = swipeActions(from, to, flags.duration);

    await this.withAuth(async () => {
      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      // The batch runs for ~duration; size the IPC timeout accordingly so
      // long swipes don't hit the daemon's 30s default.
      const ipcTimeoutMs = flags.duration + 15_000;
      if (hasActiveSession(id)) {
        await sendSessionCommand(id, 'perform-actions', [actions], ipcTimeoutMs);
      } else {
        const { client, disconnect } = await getIosInstanceClient(this.client, resolvedInstance);
        try {
          await client.performActions(actions);
        } finally {
          disconnect();
        }
      }
      this.log(`Swiped from (${from[0]}, ${from[1]}) to (${to[0]}, ${to[1]})`);
    });
  }
}

/**
 * Builds a touchDown -> interpolated touchMoves -> touchUp batch. Steps are
 * spaced ~10ms apart so the server-side gesture matches the requested
 * duration; ~3pt movement per step keeps the drag smooth.
 */
function swipeActions(from: [number, number], to: [number, number], durationMs: number): Ios.PerformAction[] {
  const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(2, Math.min(100, Math.round(distance / 3)));
  const stepDelayMs = Math.max(1, Math.round(durationMs / steps));

  const actions: Ios.PerformAction[] = [{ type: 'touchDown', x: from[0], y: from[1] }];
  for (let i = 1; i <= steps; i++) {
    actions.push(
      { type: 'wait', durationMs: stepDelayMs },
      {
        type: 'touchMove',
        x: from[0] + ((to[0] - from[0]) * i) / steps,
        y: from[1] + ((to[1] - from[1]) * i) / steps,
      },
    );
  }
  actions.push({ type: 'touchUp', x: to[0], y: to[1] });
  return actions;
}
