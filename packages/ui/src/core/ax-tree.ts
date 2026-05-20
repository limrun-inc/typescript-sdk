// Accessibility tree types, normalizers, and helpers shared by the inspect
// overlay and exported for customers building their own panels.
//
// We unify two server response shapes into a single AxSnapshot:
//
//   iOS (limulator):    {type:'elementTreeResult', id, json: '<nested-tree-json>'}
//   Android (scrcpy):   {type:'getElementTreeResult', id, payload:{nodes:[flat]}}
//                       (also emits legacy {type:'elementTreeResult', id, json:'<xml>'})
//
// Both are flattened into a single list of AxElement; positions are expressed
// in a normalized screen coordinate space derived from the root rect so
// rendering can use plain percentages.

export interface AxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxSelectors {
  AXUniqueId?: string;
  AXLabel?: string;
  resourceId?: string;
  contentDesc?: string;
  text?: string;
  className?: string;
}

export interface AxElement {
  // Stable identity for React keys / selection persistence across snapshots.
  // Prefers AXUniqueId / resourceId, falls back to a hierarchical path.
  id: string;
  // Hierarchical path within the source tree (e.g. "0.1.2"). Useful as a
  // fallback identity and for debugging.
  path: string;
  // Human label (AXLabel on iOS, content-desc/text on Android).
  label: string;
  // Value (AXValue on iOS, text on Android inputs).
  value: string;
  // Semantic role (role_description on iOS, className on Android).
  role: string;
  // Element type / class name.
  type: string;
  // Whether the element is interactive.
  enabled: boolean;
  // Whether the element currently has focus.
  focused: boolean;
  // Bounds in the screen coordinate space of AxSnapshot.screen.
  frame: AxRect;
  // Selectors that map back to SDK tapElement / tap calls.
  selectors: AxSelectors;
  // Raw platform-specific node (without children/parsedBounds extras).
  // Exposed so advanced customers can read fields we didn't surface.
  raw: Record<string, unknown>;
}

export type AxPlatform = 'ios' | 'android';

export interface AxSnapshot {
  platform: AxPlatform;
  screen: { width: number; height: number };
  elements: AxElement[];
  // Unix epoch ms when the response was decoded on the client.
  capturedAt: number;
  errors?: string[];
}

export const AX_UNAVAILABLE_ERROR = 'Accessibility unavailable on this device.';

// Hard cap to keep React render time bounded on enormous trees.
const MAX_ELEMENTS = 500;

const rectsApproxEqual = (a: AxRect, b: AxRect): boolean =>
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

const rectArea = (r: AxRect): number => Math.max(0, r.width) * Math.max(0, r.height);

// ────────────────────────────────────────────────────────────────────────────
// iOS normalization
// ────────────────────────────────────────────────────────────────────────────

interface RawIosNode {
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  // `frame` is the canonical bounds; the legacy `AXFrame` string field is
  // not consumed.
  frame?: { x: number; y: number; width: number; height: number };
  role?: string;
  role_description?: string;
  type?: string;
  subrole?: string | null;
  title?: string | null;
  enabled?: boolean;
  focused?: boolean;
  pid?: number;
  traits?: string[];
  children?: RawIosNode[];
  // Some serializations carry extras we'll preserve in `raw`.
  [key: string]: unknown;
}

// Picks the "screen rectangle" used as the denominator when expressing
// element positions as percentages.
//
// Apple's `accessibilityElementForFrontmostApplication()` returns the
// foreground Application element as the (only) root; its `frame` is the
// device's logical screen — `{x: 0, y: 0, width, height}` in points. The
// element frames inside the tree are in this same coordinate space, so a
// child at `(16, 64)` is 16pt from the device's left edge and 64pt from
// the top edge.
//
// We accept any root whose frame has positive dimensions to be robust
// against the edge case where the foreground app reports a non-zero
// origin (e.g. status bar excluded). In practice that never happens; if
// it does, percentages will be slightly off but the overlay will still
// roughly line up. The defensive console.warn helps us catch this in
// production telemetry without breaking the feature.
const iosScreenFrame = (roots: RawIosNode[]): AxRect => {
  const root = roots.find((n) => n.frame && n.frame.width > 0 && n.frame.height > 0);
  if (root?.frame) {
    if (Math.abs(root.frame.x) > 0.5 || Math.abs(root.frame.y) > 0.5) {
      console.warn(
        `[ax-tree] iOS root frame is not anchored at (0,0): ` +
          `(${root.frame.x},${root.frame.y}). Element positions may be ` +
          `slightly off from the rendered video.`,
      );
    }
    return { x: 0, y: 0, width: root.frame.width, height: root.frame.height };
  }
  return { x: 0, y: 0, width: 1, height: 1 };
};

const buildIosSelectors = (node: RawIosNode): AxSelectors => {
  const sel: AxSelectors = {};
  if (typeof node.AXUniqueId === 'string' && node.AXUniqueId.length > 0) sel.AXUniqueId = node.AXUniqueId;
  if (typeof node.AXLabel === 'string' && node.AXLabel.length > 0) sel.AXLabel = node.AXLabel;
  if (typeof node.type === 'string' && node.type.length > 0) sel.className = node.type;
  return sel;
};

const stripIosChildren = (node: RawIosNode): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'children') continue;
    out[k] = v;
  }
  return out;
};

export function normalizeIosTree(roots: RawIosNode[] | RawIosNode): AxSnapshot {
  const rootArray = Array.isArray(roots) ? roots : [roots];
  const screen = iosScreenFrame(rootArray);
  const elements: AxElement[] = [];

  const visit = (node: RawIosNode, path: string) => {
    if (elements.length >= MAX_ELEMENTS) return;
    const frame = node.frame;
    if (frame && frame.width > 0 && frame.height > 0 && !rectsApproxEqual(frame, screen)) {
      const role = (node.role_description as string | undefined) || (node.role as string | undefined) || '';
      const label =
        (typeof node.AXLabel === 'string' ? node.AXLabel : '') ||
        (typeof node.title === 'string' ? (node.title as string) : '') ||
        '';
      elements.push({
        id: typeof node.AXUniqueId === 'string' && node.AXUniqueId.length > 0 ? node.AXUniqueId : path,
        path,
        label,
        value: typeof node.AXValue === 'string' ? node.AXValue : '',
        role,
        type: typeof node.type === 'string' ? node.type : '',
        enabled: node.enabled !== false,
        focused: node.focused === true,
        frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
        selectors: buildIosSelectors(node),
        raw: stripIosChildren(node),
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < children.length && elements.length < MAX_ELEMENTS; i++) {
      visit(children[i]!, `${path}.${i}`);
    }
  };

  for (let i = 0; i < rootArray.length && elements.length < MAX_ELEMENTS; i++) {
    visit(rootArray[i]!, String(i));
  }

  return {
    platform: 'ios',
    screen: { width: screen.width, height: screen.height },
    elements,
    capturedAt: Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Android normalization
// ────────────────────────────────────────────────────────────────────────────

interface RawAndroidParsedBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

interface RawAndroidNode {
  index?: string;
  text?: string;
  resourceId?: string;
  className?: string;
  packageName?: string;
  contentDesc?: string;
  clickable?: boolean;
  enabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  scrollable?: boolean;
  selected?: boolean;
  bounds?: string;
  parsedBounds?: RawAndroidParsedBounds;
  [key: string]: unknown;
}

const androidScreenFrame = (nodes: RawAndroidNode[]): AxRect => {
  // Take the largest rect — uiautomator's first node is typically the
  // screen-spanning FrameLayout, but tolerate weirdness by scanning.
  let best: AxRect = { x: 0, y: 0, width: 1, height: 1 };
  let bestArea = 0;
  for (const n of nodes) {
    const pb = n.parsedBounds;
    if (!pb) continue;
    const w = pb.right - pb.left;
    const h = pb.bottom - pb.top;
    const area = Math.max(0, w) * Math.max(0, h);
    if (area > bestArea) {
      bestArea = area;
      best = { x: 0, y: 0, width: w, height: h };
    }
  }
  return best;
};

const buildAndroidSelectors = (node: RawAndroidNode): AxSelectors => {
  const sel: AxSelectors = {};
  if (typeof node.resourceId === 'string' && node.resourceId.length > 0) sel.resourceId = node.resourceId;
  if (typeof node.contentDesc === 'string' && node.contentDesc.length > 0) sel.contentDesc = node.contentDesc;
  if (typeof node.text === 'string' && node.text.length > 0) sel.text = node.text;
  if (typeof node.className === 'string' && node.className.length > 0) sel.className = node.className;
  return sel;
};

export function normalizeAndroidTree(nodes: RawAndroidNode[]): AxSnapshot {
  const screen = androidScreenFrame(nodes);
  const elements: AxElement[] = [];

  for (let i = 0; i < nodes.length && elements.length < MAX_ELEMENTS; i++) {
    const node = nodes[i]!;
    const pb = node.parsedBounds;
    if (!pb) continue;
    const width = Math.max(0, pb.right - pb.left);
    const height = Math.max(0, pb.bottom - pb.top);
    if (width <= 0 || height <= 0) continue;
    const frame: AxRect = { x: pb.left, y: pb.top, width, height };
    if (rectsApproxEqual(frame, { x: 0, y: 0, width: screen.width, height: screen.height })) continue;

    const label = node.contentDesc || node.text || '';
    const role = node.className || '';
    elements.push({
      id:
        node.resourceId && node.resourceId.length > 0 ? node.resourceId
        : node.contentDesc && node.contentDesc.length > 0 ? `cd:${node.contentDesc}`
        : String(i),
      path: String(i),
      label,
      value: typeof node.text === 'string' ? node.text : '',
      role,
      type: role,
      enabled: node.enabled !== false,
      focused: node.focused === true,
      frame,
      selectors: buildAndroidSelectors(node),
      raw: { ...node },
    });
  }

  return {
    platform: 'android',
    screen: { width: screen.width, height: screen.height },
    elements,
    capturedAt: Date.now(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Generic helpers (exported for customers building their own panels)
// ────────────────────────────────────────────────────────────────────────────

export function clampAxFrameForScreen(
  frame: AxRect,
  screen: { width: number; height: number },
): AxRect | null {
  const x = Math.max(0, frame.x);
  const y = Math.max(0, frame.y);
  const right = Math.min(screen.width, frame.x + frame.width);
  const bottom = Math.min(screen.height, frame.y + frame.height);
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function axElementsEqual(a: AxElement, b: AxElement): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.path !== b.path) return false;
  if (a.label !== b.label || a.value !== b.value) return false;
  if (a.role !== b.role || a.type !== b.type) return false;
  if (a.enabled !== b.enabled || a.focused !== b.focused) return false;
  const fa = a.frame;
  const fb = b.frame;
  return fa.x === fb.x && fa.y === fb.y && fa.width === fb.width && fa.height === fb.height;
}

export function axSnapshotsEqual(a: AxSnapshot | null, b: AxSnapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.platform !== b.platform) return false;
  if (a.screen.width !== b.screen.width || a.screen.height !== b.screen.height) return false;
  if (a.elements.length !== b.elements.length) return false;
  for (let i = 0; i < a.elements.length; i++) {
    if (!axElementsEqual(a.elements[i]!, b.elements[i]!)) return false;
  }
  return true;
}

// Returns the smallest matching element under the given point (in screen
// coordinate space). Used by the overlay for hit-testing when boxes overlap.
export function axElementAtPoint(snapshot: AxSnapshot, x: number, y: number): AxElement | null {
  let best: AxElement | null = null;
  let bestArea = Infinity;
  for (const el of snapshot.elements) {
    const f = el.frame;
    if (x < f.x || y < f.y || x > f.x + f.width || y > f.y + f.height) continue;
    const area = rectArea(f);
    if (area < bestArea) {
      bestArea = area;
      best = el;
    }
  }
  return best;
}

// Produces a one-line SDK selector expression that customers can paste into
// code. Returns null when no usable selector exists.
export function axElementSelectorExpression(el: AxElement, platform: AxPlatform): string | null {
  if (platform === 'ios') {
    if (el.selectors.AXUniqueId) {
      return `client.tapElement({ AXUniqueId: ${JSON.stringify(el.selectors.AXUniqueId)} })`;
    }
    if (el.selectors.AXLabel) {
      const typeHint = el.selectors.className ? `, type: ${JSON.stringify(el.selectors.className)}` : '';
      return `client.tapElement({ AXLabel: ${JSON.stringify(el.selectors.AXLabel)}${typeHint} })`;
    }
    return null;
  }
  // android
  if (el.selectors.resourceId) {
    return `client.tap({ selector: { resourceId: ${JSON.stringify(el.selectors.resourceId)} } })`;
  }
  if (el.selectors.contentDesc) {
    return `client.tap({ selector: { contentDesc: ${JSON.stringify(el.selectors.contentDesc)} } })`;
  }
  if (el.selectors.text) {
    return `client.tap({ selector: { text: ${JSON.stringify(el.selectors.text)} } })`;
  }
  return null;
}

// Cleans up internal-looking role tokens. iOS's `role_description` can be
// raw strings like "AXGenericElement" or empty when AppKit doesn't have a
// description for the role. Android sets role to the className which is
// often fully-qualified (`android.widget.TextView`); strip the package.
export function axElementRoleLabel(el: AxElement): string {
  const raw = el.role || el.type || '';
  if (!raw) return 'element';
  // Drop "AX" prefix and split CamelCase into spaced words ("AXTextField" → "Text Field").
  let cleaned = raw.replace(/^AX/, '');
  // For Android fully-qualified names, keep just the last segment.
  if (cleaned.includes('.')) {
    cleaned = cleaned.split('.').pop()!;
  }
  // Reject the generic catch-all bucket; callers can decide to hide it.
  if (cleaned === 'GenericElement') return 'Element';
  // Lightly humanize CamelCase.
  cleaned = cleaned.replace(/([a-z])([A-Z])/g, '$1 $2');
  return cleaned;
}

// A short human-readable summary used in tooltips and the info card title.
// Truncated to avoid blowing up tooltips on elements with paragraph-length
// AXLabels.
const SUMMARY_MAX_LABEL_LEN = 80;
export function axElementSummary(el: AxElement): string {
  const role = axElementRoleLabel(el);
  const text = el.label || el.value || '';
  if (!text) return role;
  const trimmed =
    text.length > SUMMARY_MAX_LABEL_LEN ? text.slice(0, SUMMARY_MAX_LABEL_LEN).trimEnd() + '…' : text;
  return `${role} · ${trimmed}`;
}
