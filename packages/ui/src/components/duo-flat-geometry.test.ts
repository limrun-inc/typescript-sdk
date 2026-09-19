import { describe, expect, it } from 'vitest';
import { flatFrameGeometry, flatHoverEdge } from './duo-flat-geometry';

describe('2D Duo frame controls', () => {
  for (const inner of [false, true]) {
    for (const turns of [0, 1, 2, 3]) {
      it('keeps ' + (inner ? 'inner' : 'cover') + ' controls outside the glass at rotation ' + turns, () => {
        for (const [width, height] of [
          [320, 240],
          [440, 650],
          [1000, 800],
        ]) {
          const f = flatFrameGeometry(inner, turns, width!, height!);
          expect(f.scale).toBeGreaterThan(0);
          for (const g of f.guides) {
            expect(g.x - 22).toBeGreaterThanOrEqual(0);
            expect(g.x + 22).toBeLessThanOrEqual(width!);
            expect(g.y - 22).toBeGreaterThanOrEqual(0);
            expect(g.y + 22).toBeLessThanOrEqual(height!);
            expect(g.x < f.rect.min.x || g.x > f.rect.max.x || g.y < f.rect.min.y || g.y > f.rect.max.y).toBe(
              true,
            );
            expect(flatHoverEdge(g.x, g.y, f.rect)).toBe(g.edge);
          }
          const volume = f.guides.filter((g) => g.button !== 'side');
          expect(Math.hypot(volume[0]!.x - volume[1]!.x, volume[0]!.y - volume[1]!.y)).toBeGreaterThanOrEqual(
            48,
          );
        }
      });
    }
  }
  it('uses the 3D body proportions and rotates the inner display from native portrait pixels', () => {
    const folded = flatFrameGeometry(false, 0, 500, 700);
    const unfolded = flatFrameGeometry(true, 1, 700, 500);
    expect(folded.bodyWidth * 2).toBe(unfolded.bodyWidth);
    expect(folded.bodyHeight).toBe(unfolded.bodyHeight);
    expect(unfolded.turns).toBe(0);
    expect(flatFrameGeometry(true, 0, 500, 700).turns).toBe(3);
  });
});
