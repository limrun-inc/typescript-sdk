import { describe, expect, it } from 'vitest';
import {
  MACBOOK,
  MACBOOK_EXTRA_HEIGHT,
  MACBOOK_LID_WIDTH,
  MACBOOK_VERTEX_FLOATS,
  MACBOOK_WIDTH,
  macbookDimensions,
  macbookMeshes,
  streamFit,
  streamPoint,
  type MacbookMesh,
} from './macbook-geometry';
import { lidPose } from './macbook-lid-renderer';

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

  // Head on with the lid upright, the 3D model must cover the CSS frame exactly, so the WebGL
  // opening hands over to it without a jump.
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

it('opens the lid from closed to upright while the view drops to straight on', () => {
  expect(lidPose(0)).toEqual({ angle: Math.PI / 2, pitch: 0.42 });
  expect(lidPose(1)).toEqual({ angle: 0, pitch: 0 });
  const middle = lidPose(0.5);
  expect(middle.angle).toBeGreaterThan(0);
  expect(middle.angle).toBeLessThan(Math.PI / 2);
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

  it('puts bars on the sides of a narrower stream', () => {
    const narrow = streamFit(4 / 3, 1.545);
    expect(streamPoint(0.01, 0.5, narrow)).toBeUndefined();
    expect(streamPoint(0.5, 0, narrow)).toEqual({ x: 0.5, y: 1 });
  });
});
