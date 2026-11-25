import { describe, expect, it } from 'vitest';
import {
  MACBOOK,
  MACBOOK_EXTRA_HEIGHT,
  MACBOOK_LID_WIDTH,
  MACBOOK_VERTEX_FLOATS,
  MACBOOK_WIDTH,
  macbookDimensions,
  MACBOOK_LID_CLOSED,
  lidEase,
  lidRotation,
  macbookMeshes,
  streamFit,
  streamPoint,
  type MacbookMesh,
} from './macbook-geometry';

function bounds(meshes: MacbookMesh[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.vertices.length; i += MACBOOK_VERTEX_FLOATS) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, mesh.vertices[i + axis]!);
        max[axis] = Math.max(max[axis]!, mesh.vertices[i + axis]!);
      }
    }
  }
  return { min, max };
}

const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 5);

describe.each([16 / 10, 16 / 9, 4 / 3])('the MacBook for a %f screen', (aspect) => {
  const meshes = macbookMeshes(aspect);
  const { lidHeight, screenHeight } = macbookDimensions(aspect);

  // Head on with the lid upright, the built-in 3D model covers the CSS frame exactly, so the two
  // MacBooks match.
  it('covers the CSS frame when seen head on', () => {
    const { min, max } = bounds(meshes);
    close(min[0]!, -MACBOOK_WIDTH / 2);
    close(max[0]!, MACBOOK_WIDTH / 2);
    close(min[1]!, -MACBOOK.baseHeight);
    close(max[1]!, lidHeight);
    close(max[1]! - min[1]!, screenHeight + MACBOOK_EXTRA_HEIGHT);
    const lid = bounds(meshes.filter((mesh) => mesh.part === 'lid'));
    close(lid.max[0]! - lid.min[0]!, MACBOOK_LID_WIDTH);
  });

  it('puts the screen where the CSS frame puts the video', () => {
    const screen = bounds(meshes.filter((mesh) => mesh.kind === 'screen'));
    close(screen.min[0]!, -50);
    close(screen.max[0]!, 50);
    close(screen.min[1]!, MACBOOK.chin);
    close(screen.max[1]!, MACBOOK.chin + screenHeight);
  });

  it('maps the stream upright onto the screen', () => {
    const screen = meshes.find((mesh) => mesh.kind === 'screen')!.vertices;
    for (let i = 0; i < screen.length; i += MACBOOK_VERTEX_FLOATS) {
      close(screen[i + 6]!, (screen[i]! + 50) / 100);
      close(screen[i + 7]!, (screen[i + 1]! - MACBOOK.chin) / screenHeight);
    }
  });
});

it('draws each material once', () => {
  const meshes = macbookMeshes(16 / 10);
  const keys = meshes.map((mesh) => `${mesh.part}:${mesh.kind}`);
  expect(new Set(keys).size).toBe(keys.length);
});

it('turns the lid from closed by its opening in degrees', () => {
  close(lidRotation(0), MACBOOK_LID_CLOSED);
  // Upright is 90° open; past it the lid leans back.
  close(lidRotation(90), MACBOOK_LID_CLOSED - Math.PI / 2);
  expect(lidRotation(100)).toBeLessThan(lidRotation(90));
});

it('moves the lid fast at first, slowing to a stop', () => {
  close(lidEase(0), 0);
  close(lidEase(1), 1);
  close(lidEase(1.5), 1);
  // Each tenth of the time moves the lid less than the one before.
  const steps = Array.from({ length: 10 }, (_, i) => lidEase((i + 1) / 10) - lidEase(i / 10));
  for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]!);
});

describe('a stream on a display of another shape', () => {
  // A 16:9 guest on the 16-inch MacBook Pro's 1.545 panel: bars above and below.
  const fit = streamFit(16 / 9, 1.545);

  it('fills a display of its own shape exactly', () => {
    expect(streamFit(1.6, 1.6)).toEqual({ repeat: [1, 1], offset: [0, 0] });
  });

  it('keeps its shape, centered, with bars on the sides it does not reach', () => {
    expect(streamPoint(0.5, 0.5, fit)).toEqual({ x: 0.5, y: 0.5 });
    const top = streamPoint(0, 0.99, fit);
    expect(top).toBeUndefined();
    // The stream's top edge sits a bar's height below the display's.
    const bar = (1 - 1.545 / (16 / 9)) / 2;
    const corner = streamPoint(0, 1 - bar, fit)!;
    expect(corner.x).toBeCloseTo(0, 5);
    expect(corner.y).toBeCloseTo(0, 5);
  });

  it('keeps a 16:10 stream below the notch, filling the band macOS leaves it', () => {
    // The 16-inch panel is 3456 × 2234 and its notch takes the top 74 rows.
    const below = streamFit(16 / 10, 3456 / 2234, 74 / 2234);
    const share = 74 / 2234;
    expect(streamPoint(0.5, 1 - share / 2, below)).toBeUndefined();
    const topLeft = streamPoint(0, 1 - share, below)!;
    expect(topLeft.x).toBeCloseTo(0, 5);
    expect(topLeft.y).toBeCloseTo(0, 5);
    const bottomRight = streamPoint(1, 0, below)!;
    expect(bottomRight.x).toBeCloseTo(1, 5);
    expect(bottomRight.y).toBeCloseTo(1, 5);
  });

  it('puts bars on the sides of a narrower stream', () => {
    const narrow = streamFit(4 / 3, 1.545);
    expect(streamPoint(0.01, 0.5, narrow)).toBeUndefined();
    expect(streamPoint(0.5, 0, narrow)).toEqual({ x: 0.5, y: 1 });
  });
});
