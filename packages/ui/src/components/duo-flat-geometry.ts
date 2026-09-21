import { DUO_DIMENSIONS, type DuoButton } from '../core/duo';

type Edge = 'top' | 'right' | 'bottom' | 'left';

/** A front projection of the 3D body's dimensions, with room for its edge controls. */
export function flatFrameGeometry(inner: boolean, displayTurns: number, width: number, height: number) {
  const bodyWidth = DUO_DIMENSIONS.width / (inner ? 1 : 2);
  const bodyHeight = DUO_DIMENSIONS.height;
  const screenWidth = inner ? 157.5 : 77.1;
  const screenHeight = inner ? 110.8 : 112.2;
  const turns = (displayTurns + (inner ? 3 : 0)) % 4;
  const scale = Math.max(
    0,
    Math.min(
      (width - 120) / (turns % 2 ? bodyHeight : bodyWidth),
      (height - 120) / (turns % 2 ? bodyWidth : bodyHeight),
    ),
  );
  const project = (x: number, y: number) => {
    x = (x - bodyWidth / 2) * scale;
    y = (y - bodyHeight / 2) * scale;
    const p =
      turns === 1 ? { x: -y, y: x }
      : turns === 2 ? { x: -x, y: -y }
      : turns === 3 ? { x: y, y: -x }
      : { x, y };
    return { x: p.x + width / 2, y: p.y + height / 2 };
  };
  const horizontal = (turns % 2 ? bodyHeight : bodyWidth) * scale;
  const vertical = (turns % 2 ? bodyWidth : bodyHeight) * scale;
  const rect = {
    min: { x: (width - horizontal) / 2, y: (height - vertical) / 2 },
    max: { x: (width + horizontal) / 2, y: (height + vertical) / 2 },
  };
  const buttons: { button: DuoButton; x: number; y: number; width: number; height: number; edge: Edge }[] = [
    { button: 'volumeDown', x: bodyWidth - 37, y: -0.32, width: 9.5, height: 0.65, edge: 'top' },
    { button: 'volumeUp', x: bodyWidth - 25, y: -0.32, width: 9.5, height: 0.65, edge: 'top' },
    { button: 'side', x: bodyWidth + 0.35, y: bodyHeight / 2 - 21, width: 0.7, height: 13, edge: 'right' },
  ];
  const edges: Edge[] = ['top', 'right', 'bottom', 'left'];
  const guides = buttons.map((b) => {
    const edge = edges[(edges.indexOf(b.edge) + turns) % 4]!;
    const p = project(b.x, b.y);
    if (edge === 'top') p.y = rect.min.y - 28;
    if (edge === 'bottom') p.y = rect.max.y + 28;
    if (edge === 'left') p.x = rect.min.x - 28;
    if (edge === 'right') p.x = rect.max.x + 28;
    return { button: b.button, edge, ...p, targetX: p.x, targetY: p.y };
  });
  const volume = guides.filter((g) => g.button !== 'side');
  const axis = turns % 2 ? 'y' : 'x';
  volume.sort((a, b) => a[axis] - b[axis]);
  // Keep glyphs over the metal caps; only spread their invisible click areas.
  const targetAxis = turns % 2 ? 'targetY' : 'targetX';
  if (volume[1]![axis] - volume[0]![axis] < 44) {
    const center = (volume[0]![axis] + volume[1]![axis]) / 2;
    volume[0]![targetAxis] = center - 22;
    volume[1]![targetAxis] = center + 22;
  }
  return {
    bodyWidth,
    bodyHeight,
    screenWidth,
    screenHeight,
    scale,
    turns,
    buttons,
    guides,
    rect,
    iconSize: Math.min(hardwareIconSize(rect), 12 * scale),
  };
}

/** Scale the glyph with the device while its surrounding click target stays 44 pixels. */
export function hardwareIconSize(rect: { min: { x: number; y: number }; max: { x: number; y: number } }) {
  return Math.max(12, Math.min(24, Math.max(rect.max.x - rect.min.x, rect.max.y - rect.min.y) / 24));
}

/** The hover band joins the metal edge to its icons without covering the display. */
export function flatHoverEdge(
  x: number,
  y: number,
  rect: ReturnType<typeof flatFrameGeometry>['rect'],
): Edge | undefined {
  const edges: [Edge, number, number, number, number][] = [
    ['top', rect.min.y - y, x, rect.min.x, rect.max.x],
    ['bottom', y - rect.max.y, x, rect.min.x, rect.max.x],
    ['left', rect.min.x - x, y, rect.min.y, rect.max.y],
    ['right', x - rect.max.x, y, rect.min.y, rect.max.y],
  ];
  return edges
    .filter(
      ([, distance, along, min, max]) =>
        distance >= -7 && distance <= 52 && along >= min - 12 && along <= max + 12,
    )
    .sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]))[0]?.[0];
}
