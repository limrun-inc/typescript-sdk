// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { formatTerminationReason } from './termination-reason';

describe('formatTerminationReason', () => {
  it.each([
    ['UserRequested', 'User requested'],
    ['InactivityTimeout', 'Inactivity timeout'],
    ['HardTimeout', 'Hard timeout'],
    ['Unknown', 'Unknown'],
    ['FutureReason', 'Unknown'],
  ])('formats %s as %s', (reason, expected) => {
    expect(formatTerminationReason(reason)).toBe(expected);
  });
});
