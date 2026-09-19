import { describe, expect, it } from 'vitest';
import { flatFrameGeometry, flatHoverEdge, hardwareIconSize } from './duo-flat-geometry';

describe('2D Duo frame controls', () => {
  it('shrinks glyphs with the device without shrinking click targets', () => {
    const compact = flatFrameGeometry(false, 0, 320, 360);
    const regular = flatFrameGeometry(false, 0, 600, 600);
    const large = flatFrameGeometry(false, 0, 1000, 1000);
    expect(compact.iconSize).toBe(12);
    expect(regular.iconSize).toBe(20);
    expect(large.iconSize).toBe(24);
    expect(hardwareIconSize({ min: { x: 0, y: 0 }, max: { x: 0, y: 0 } })).toBe(12);
  });
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
            expect(g.targetX - 22).toBeGreaterThanOrEqual(0);
            expect(g.targetX + 22).toBeLessThanOrEqual(width!);
            expect(g.targetY - 22).toBeGreaterThanOrEqual(0);
            expect(g.targetY + 22).toBeLessThanOrEqual(height!);
            expect(Math.abs(g.x - g.targetX) + f.iconSize / 2).toBeLessThanOrEqual(22.000001);
            expect(Math.abs(g.y - g.targetY) + f.iconSize / 2).toBeLessThanOrEqual(22.000001);
            expect(g.x < f.rect.min.x || g.x > f.rect.max.x || g.y < f.rect.min.y || g.y > f.rect.max.y).toBe(
              true,
            );
            expect(flatHoverEdge(g.x, g.y, f.rect)).toBe(g.edge);
          }
          const volume = f.guides.filter((g) => g.button !== 'side');
          expect(
            Math.hypot(volume[0]!.targetX - volume[1]!.targetX, volume[0]!.targetY - volume[1]!.targetY),
          ).toBeGreaterThanOrEqual(44);
          for (const g of f.guides) {
            const b = f.buttons.find((b) => b.button === g.button)!;
            const radians = (f.turns * Math.PI) / 2;
            const x = (b.x - f.bodyWidth / 2) * f.scale;
            const y = (b.y - f.bodyHeight / 2) * f.scale;
            if (g.edge === 'top' || g.edge === 'bottom') {
              expect(g.x).toBeCloseTo(width! / 2 + x * Math.cos(radians) - y * Math.sin(radians));
            } else {
              expect(g.y).toBeCloseTo(height! / 2 + x * Math.sin(radians) + y * Math.cos(radians));
            }
          }
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
