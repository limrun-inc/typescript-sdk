import { describe, expect, it } from 'vitest';

import { AMOTION_EVENT } from './constants';
import { getAndroidTwoFingerTouchSteps } from './android-touch';

describe('getAndroidTwoFingerTouchSteps', () => {
  it('only presses the second pointer when the first is already down', () => {
    expect(getAndroidTwoFingerTouchSteps('down', true)).toEqual([
      { action: AMOTION_EVENT.ACTION_DOWN, pointerIndex: 1 },
    ]);
  });

  it('uses per-pointer DOWN and UP actions for a complete gesture', () => {
    expect(getAndroidTwoFingerTouchSteps('down')).toEqual([
      { action: AMOTION_EVENT.ACTION_DOWN, pointerIndex: 0 },
      { action: AMOTION_EVENT.ACTION_DOWN, pointerIndex: 1 },
    ]);
    expect(getAndroidTwoFingerTouchSteps('up')).toEqual([
      { action: AMOTION_EVENT.ACTION_UP, pointerIndex: 1 },
      { action: AMOTION_EVENT.ACTION_UP, pointerIndex: 0 },
    ]);
  });
});
