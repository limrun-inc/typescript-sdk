import { describe, expect, it } from 'vitest';
import { addDuoRevision, isDuoViewport, matchesDuoVideo, type DuoViewport } from './duo';

const open: DuoViewport = {
  profile: 'duo-preview-v1',
  pose: 'open',
  revision: 7,
  width: 890,
  height: 626,
  scale: 3,
  runtimeBuild: '24A434',
};

describe('Duo input revision', () => {
  it('preserves every original touch byte and appends a little-endian revision', () => {
    for (const [type, length] of [
      [2, 32],
      [18, 24],
    ]) {
      const original = Uint8Array.from({ length: length! }, (_, index) => (index === 0 ? type! : index));
      const tagged = addDuoRevision(original.buffer, open);
      expect(new Uint8Array(tagged).slice(0, length)).toEqual(original);
      expect(tagged.byteLength).toBe(length! + 4);
      expect(new DataView(tagged).getUint32(length!, true)).toBe(7);
    }
  });
  it('leaves keyboard and clipboard payloads unchanged', () => {
    for (const type of [0, 9]) {
      const original = new Uint8Array([type, 1, 2]).buffer;
      expect(addDuoRevision(original, open)).toBe(original);
    }
  });
  it('rejects the previous pose but accepts encoder alignment rounding', () => {
    expect(matchesDuoVideo(open, 1398, 2034)).toBe(false);
    expect(matchesDuoVideo(open, 2000, 1408)).toBe(true);
    expect(matchesDuoVideo(open, 0, 0)).toBe(false);
  });
  it('does not activate preview controls for malformed or unsupported metadata', () => {
    expect(isDuoViewport(open)).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...open, revision: -1 },
      { ...open, runtimeBuild: 'different' },
      { ...open, width: 466 },
    ]) {
      expect(isDuoViewport(invalid)).toBe(false);
    }
  });
});
