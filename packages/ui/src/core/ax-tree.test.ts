// @vitest-environment node
//
// Tests for `core/ax-tree.ts` — pure normalizers + helpers, no DOM required.
//
// These cover the contract customers depend on through `onAxSnapshotChange`
// and the exported helpers, so regressions here surface as silent overlay
// drift or selector copy-paste pain.

import { describe, expect, test } from 'vitest';
import {
  AxElement,
  AxSnapshot,
  AX_UNAVAILABLE_ERROR,
  axElementAtPoint,
  axElementRoleLabel,
  axElementSelectorExpression,
  axElementSummary,
  axElementsEqual,
  axSnapshotsEqual,
  clampAxFrameForScreen,
  normalizeAndroidTree,
  normalizeIosTree,
} from './ax-tree';

// ────────────────────────────────────────────────────────────────────────────
// normalizeIosTree
// ────────────────────────────────────────────────────────────────────────────

describe('normalizeIosTree', () => {
  test('flattens nested children, skipping the screen-sized root', () => {
    const tree = [
      {
        // root = whole screen, should be filtered
        frame: { x: 0, y: 0, width: 393, height: 852 },
        type: 'Application',
        children: [
          {
            frame: { x: 16, y: 64, width: 200, height: 40 },
            type: 'Button',
            AXLabel: 'Sign in',
            AXUniqueId: 'signin-button',
            children: [
              {
                frame: { x: 24, y: 70, width: 80, height: 20 },
                type: 'StaticText',
                AXLabel: 'Sign in',
              },
            ],
          },
        ],
      },
    ];

    const snap = normalizeIosTree(tree);

    expect(snap.platform).toBe('ios');
    expect(snap.screen).toEqual({ width: 393, height: 852 });
    // Application (root, screen-sized) skipped; button + nested text kept.
    expect(snap.elements).toHaveLength(2);
    expect(snap.elements[0].label).toBe('Sign in');
    expect(snap.elements[0].id).toBe('signin-button');
    expect(snap.elements[0].selectors.AXUniqueId).toBe('signin-button');
    expect(snap.elements[1].path).toBe('0.0.0');
  });

  test('drops zero-area frames', () => {
    const tree = [
      {
        frame: { x: 0, y: 0, width: 400, height: 800 },
        type: 'Application',
        children: [
          { frame: { x: 0, y: 0, width: 0, height: 50 }, type: 'Invisible' },
          { frame: { x: 0, y: 0, width: 50, height: 0 }, type: 'Invisible' },
          { frame: { x: -10, y: 10, width: -5, height: 10 }, type: 'Invisible' },
          { frame: { x: 10, y: 10, width: 50, height: 50 }, type: 'Visible' },
        ],
      },
    ];
    const snap = normalizeIosTree(tree);
    expect(snap.elements).toHaveLength(1);
    expect(snap.elements[0].type).toBe('Visible');
  });

  test('caps at MAX_ELEMENTS (500) even on huge trees', () => {
    const children = Array.from({ length: 1000 }, (_, i) => ({
      frame: { x: i, y: 0, width: 1, height: 1 },
      type: 'T',
    }));
    const snap = normalizeIosTree([
      {
        frame: { x: 0, y: 0, width: 1000, height: 1 },
        type: 'Root',
        children,
      },
    ]);
    expect(snap.elements.length).toBeLessThanOrEqual(500);
  });

  test('falls back to path id when AXUniqueId is missing', () => {
    const snap = normalizeIosTree([
      {
        frame: { x: 0, y: 0, width: 400, height: 800 },
        type: 'Application',
        children: [
          { frame: { x: 0, y: 0, width: 50, height: 50 }, type: 'A' },
          { frame: { x: 0, y: 0, width: 50, height: 50 }, type: 'B', AXUniqueId: 'b-id' },
        ],
      },
    ]);
    expect(snap.elements[0].id).toBe('0.0');
    expect(snap.elements[1].id).toBe('b-id');
  });

  test('accepts a single-object root (not an array)', () => {
    const snap = normalizeIosTree({
      frame: { x: 0, y: 0, width: 200, height: 400 },
      type: 'Application',
      children: [{ frame: { x: 10, y: 10, width: 30, height: 30 }, type: 'X' }],
    });
    expect(snap.elements).toHaveLength(1);
    expect(snap.screen).toEqual({ width: 200, height: 400 });
  });

  test('returns a usable empty snapshot for an empty input', () => {
    const snap = normalizeIosTree([]);
    expect(snap.elements).toEqual([]);
    expect(snap.platform).toBe('ios');
    expect(snap.screen.width).toBeGreaterThan(0);
  });

  test('strips children from `raw` to avoid retaining the whole subtree', () => {
    const snap = normalizeIosTree([
      {
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          {
            frame: { x: 0, y: 0, width: 50, height: 50 },
            type: 'A',
            AXLabel: 'A',
            children: [{ frame: { x: 0, y: 0, width: 25, height: 25 }, type: 'A-Child' }],
          },
        ],
      },
    ]);
    const a = snap.elements.find((e) => e.label === 'A')!;
    expect(a.raw).not.toHaveProperty('children');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// normalizeAndroidTree
// ────────────────────────────────────────────────────────────────────────────

describe('normalizeAndroidTree', () => {
  const mkNode = (overrides: Partial<Record<string, unknown>> = {}) => ({
    resourceId: '',
    text: '',
    contentDesc: '',
    className: 'android.widget.View',
    parsedBounds: { left: 0, top: 0, right: 50, bottom: 50, centerX: 25, centerY: 25 },
    enabled: true,
    ...overrides,
  });

  test('uses the largest rect as the screen frame', () => {
    const nodes = [
      // not the largest — should not be picked
      { parsedBounds: { left: 0, top: 0, right: 100, bottom: 100, centerX: 50, centerY: 50 } },
      // largest — screen
      {
        parsedBounds: { left: 0, top: 0, right: 1080, bottom: 2400, centerX: 540, centerY: 1200 },
      },
    ];
    const snap = normalizeAndroidTree(nodes);
    expect(snap.screen).toEqual({ width: 1080, height: 2400 });
  });

  test('drops the screen-sized rect and keeps children', () => {
    const nodes = [
      // screen
      {
        className: 'android.widget.FrameLayout',
        parsedBounds: { left: 0, top: 0, right: 1080, bottom: 2400, centerX: 540, centerY: 1200 },
      },
      mkNode({
        resourceId: 'btn-home',
        contentDesc: 'Home',
        parsedBounds: {
          left: 100,
          top: 2300,
          right: 200,
          bottom: 2400,
          centerX: 150,
          centerY: 2350,
        },
      }),
    ];
    const snap = normalizeAndroidTree(nodes);
    expect(snap.elements.map((e) => e.id)).toEqual(['btn-home']);
    expect(snap.elements[0].label).toBe('Home');
    expect(snap.elements[0].selectors.resourceId).toBe('btn-home');
  });

  test('synthesizes a `cd:` id when resourceId is missing but contentDesc is present', () => {
    const nodes = [
      {
        parsedBounds: { left: 0, top: 0, right: 1080, bottom: 2400, centerX: 540, centerY: 1200 },
      },
      mkNode({
        contentDesc: 'Settings',
        parsedBounds: {
          left: 10,
          top: 10,
          right: 60,
          bottom: 60,
          centerX: 35,
          centerY: 35,
        },
      }),
    ];
    const snap = normalizeAndroidTree(nodes);
    expect(snap.elements[0].id).toBe('cd:Settings');
  });

  test('skips nodes with no parsedBounds or zero area', () => {
    const nodes = [
      {
        parsedBounds: { left: 0, top: 0, right: 1080, bottom: 2400, centerX: 540, centerY: 1200 },
      },
      mkNode({ parsedBounds: undefined }),
      mkNode({
        parsedBounds: { left: 10, top: 10, right: 10, bottom: 50, centerX: 10, centerY: 30 },
      }),
    ];
    const snap = normalizeAndroidTree(nodes);
    expect(snap.elements).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────────

describe('clampAxFrameForScreen', () => {
  const screen = { width: 100, height: 100 };

  test('returns the frame unchanged when fully inside', () => {
    expect(clampAxFrameForScreen({ x: 10, y: 10, width: 50, height: 50 }, screen)).toEqual({
      x: 10,
      y: 10,
      width: 50,
      height: 50,
    });
  });

  test('clips a frame that overhangs the right/bottom edges', () => {
    expect(clampAxFrameForScreen({ x: 80, y: 80, width: 40, height: 40 }, screen)).toEqual({
      x: 80,
      y: 80,
      width: 20,
      height: 20,
    });
  });

  test('clamps negative x/y to zero and reduces width/height accordingly', () => {
    expect(clampAxFrameForScreen({ x: -10, y: -20, width: 30, height: 30 }, screen)).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 10,
    });
  });

  test('returns null when the visible area becomes empty', () => {
    expect(clampAxFrameForScreen({ x: 200, y: 200, width: 10, height: 10 }, screen)).toBeNull();
    expect(clampAxFrameForScreen({ x: 0, y: 0, width: 0, height: 100 }, screen)).toBeNull();
  });
});

describe('axElementAtPoint', () => {
  const mkEl = (id: string, x: number, y: number, w: number, h: number): AxElement => ({
    id,
    path: id,
    label: id,
    value: '',
    role: '',
    type: '',
    enabled: true,
    focused: false,
    frame: { x, y, width: w, height: h },
    selectors: {},
    raw: {},
  });

  const snap: AxSnapshot = {
    platform: 'ios',
    screen: { width: 1000, height: 1000 },
    elements: [
      mkEl('outer', 0, 0, 1000, 1000),
      mkEl('mid', 100, 100, 800, 800),
      mkEl('inner', 400, 400, 200, 200),
    ],
    capturedAt: 0,
  };

  test('picks the smallest element under the point', () => {
    expect(axElementAtPoint(snap, 500, 500)?.id).toBe('inner');
  });

  test('falls back to a larger element when the smaller one does not contain the point', () => {
    expect(axElementAtPoint(snap, 200, 200)?.id).toBe('mid');
  });

  test('returns null for points outside all rects', () => {
    expect(axElementAtPoint(snap, -10, -10)).toBeNull();
    expect(axElementAtPoint(snap, 2000, 2000)).toBeNull();
  });

  test('boundary point on the right/bottom edge is considered inside', () => {
    // 600, 600 = exactly the right/bottom edge of `inner` (400+200, 400+200)
    expect(axElementAtPoint(snap, 600, 600)?.id).toBe('inner');
  });
});

describe('axElementsEqual & axSnapshotsEqual', () => {
  const mkEl = (id: string, frame: { x: number; y: number; width: number; height: number }): AxElement => ({
    id,
    path: id,
    label: 'L',
    value: '',
    role: 'r',
    type: 't',
    enabled: true,
    focused: false,
    frame,
    selectors: {},
    raw: {},
  });

  test('axElementsEqual returns true for content-identical elements', () => {
    expect(
      axElementsEqual(
        mkEl('a', { x: 0, y: 0, width: 1, height: 1 }),
        mkEl('a', { x: 0, y: 0, width: 1, height: 1 }),
      ),
    ).toBe(true);
  });

  test('axElementsEqual returns false on any field difference', () => {
    const a = mkEl('a', { x: 0, y: 0, width: 1, height: 1 });
    expect(axElementsEqual(a, { ...a, frame: { ...a.frame, x: 1 } })).toBe(false);
    expect(axElementsEqual(a, { ...a, label: 'X' })).toBe(false);
  });

  test('axSnapshotsEqual compares element lists in order', () => {
    const e1 = mkEl('a', { x: 0, y: 0, width: 1, height: 1 });
    const e2 = mkEl('b', { x: 1, y: 1, width: 1, height: 1 });
    const s1: AxSnapshot = {
      platform: 'ios',
      screen: { width: 10, height: 10 },
      elements: [e1, e2],
      capturedAt: 100,
    };
    const s2: AxSnapshot = { ...s1, capturedAt: 200 };
    // capturedAt is metadata, not content — equal.
    expect(axSnapshotsEqual(s1, s2)).toBe(true);

    const s3: AxSnapshot = { ...s1, elements: [e2, e1] };
    expect(axSnapshotsEqual(s1, s3)).toBe(false);

    expect(axSnapshotsEqual(null, null)).toBe(true);
    expect(axSnapshotsEqual(null, s1)).toBe(false);
  });
});

describe('axElementRoleLabel', () => {
  const mk = (role: string, type = ''): AxElement => ({
    id: '0',
    path: '0',
    label: '',
    value: '',
    role,
    type,
    enabled: true,
    focused: false,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    selectors: {},
    raw: {},
  });

  test('strips AX prefix and splits CamelCase', () => {
    expect(axElementRoleLabel(mk('AXTextField'))).toBe('Text Field');
    expect(axElementRoleLabel(mk('AXButton'))).toBe('Button');
  });

  test('rewrites GenericElement to "Element"', () => {
    expect(axElementRoleLabel(mk('AXGenericElement'))).toBe('Element');
  });

  test('reduces fully-qualified Android class names to the last segment and humanizes', () => {
    expect(axElementRoleLabel(mk('android.widget.TextView'))).toBe('Text View');
    expect(axElementRoleLabel(mk('android.widget.FrameLayout'))).toBe('Frame Layout');
  });

  test('falls back to "element" for empty role/type', () => {
    expect(axElementRoleLabel(mk('', ''))).toBe('element');
  });
});

describe('axElementSummary', () => {
  const mk = (label: string, role = 'Button'): AxElement => ({
    id: '0',
    path: '0',
    label,
    value: '',
    role,
    type: '',
    enabled: true,
    focused: false,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    selectors: {},
    raw: {},
  });

  test('concatenates role and label', () => {
    expect(axElementSummary(mk('Sign in'))).toBe('Button · Sign in');
  });

  test('truncates long labels with ellipsis', () => {
    const long = 'a'.repeat(120);
    const summary = axElementSummary(mk(long));
    expect(summary.length).toBeLessThan(120);
    expect(summary).toMatch(/…$/);
  });

  test('drops label when empty', () => {
    expect(axElementSummary(mk(''))).toBe('Button');
  });
});

describe('axElementSelectorExpression', () => {
  const mkIos = (sel: Partial<AxElement['selectors']>): AxElement => ({
    id: '0',
    path: '0',
    label: '',
    value: '',
    role: '',
    type: '',
    enabled: true,
    focused: false,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    selectors: sel,
    raw: {},
  });

  test('iOS: prefers AXUniqueId', () => {
    expect(axElementSelectorExpression(mkIos({ AXUniqueId: 'signin' }), 'ios')).toBe(
      'client.tapElement({ AXUniqueId: "signin" })',
    );
  });

  test('iOS: falls back to AXLabel + type hint', () => {
    expect(axElementSelectorExpression(mkIos({ AXLabel: 'OK', className: 'Button' }), 'ios')).toBe(
      'client.tapElement({ AXLabel: "OK", type: "Button" })',
    );
  });

  test('iOS: returns null when no selectors are usable', () => {
    expect(axElementSelectorExpression(mkIos({}), 'ios')).toBeNull();
    expect(axElementSelectorExpression(mkIos({ className: 'OnlyClass' }), 'ios')).toBeNull();
  });

  test('Android: prefers resourceId, then contentDesc, then text', () => {
    expect(axElementSelectorExpression(mkIos({ resourceId: 'r1' }), 'android')).toMatch(/resourceId/);
    expect(axElementSelectorExpression(mkIos({ contentDesc: 'cd' }), 'android')).toMatch(/contentDesc/);
    expect(axElementSelectorExpression(mkIos({ text: 't' }), 'android')).toMatch(/text/);
  });

  test('escapes quotes in selector values via JSON.stringify', () => {
    expect(axElementSelectorExpression(mkIos({ AXLabel: 'has "quotes"' }), 'ios')).toContain(
      'AXLabel: "has \\"quotes\\""',
    );
  });
});

describe('AX_UNAVAILABLE_ERROR', () => {
  test('is a non-empty string customers can compare against', () => {
    expect(typeof AX_UNAVAILABLE_ERROR).toBe('string');
    expect(AX_UNAVAILABLE_ERROR.length).toBeGreaterThan(0);
  });
});
