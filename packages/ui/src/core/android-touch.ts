import { AMOTION_EVENT } from './constants';

export type AndroidTwoFingerEventType = 'down' | 'move' | 'up';

export type AndroidTouchStep = {
  action: number;
  pointerIndex: 0 | 1;
};

export function getAndroidTwoFingerTouchSteps(
  eventType: AndroidTwoFingerEventType,
  firstPointerAlreadyDown = false,
): AndroidTouchStep[] {
  switch (eventType) {
    case 'down':
      return [
        ...(!firstPointerAlreadyDown ?
          [{ action: AMOTION_EVENT.ACTION_DOWN, pointerIndex: 0 as const }]
        : []),
        { action: AMOTION_EVENT.ACTION_DOWN, pointerIndex: 1 },
      ];
    case 'move':
      return [
        { action: AMOTION_EVENT.ACTION_MOVE, pointerIndex: 0 },
        { action: AMOTION_EVENT.ACTION_MOVE, pointerIndex: 1 },
      ];
    case 'up':
      return [
        { action: AMOTION_EVENT.ACTION_UP, pointerIndex: 1 },
        { action: AMOTION_EVENT.ACTION_UP, pointerIndex: 0 },
      ];
  }
}
