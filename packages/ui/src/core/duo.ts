export type DuoViewport = {
  profile: 'duo-preview-v1';
  pose: 'open' | 'closed';
  revision: number;
  width: number;
  height: number;
  scale: number;
  runtimeBuild: string;
};

export function isDuoViewport(value: unknown): value is DuoViewport {
  if (!value || typeof value !== 'object') return false;
  const view = value as DuoViewport;
  return (
    view.profile === 'duo-preview-v1' &&
    Number.isSafeInteger(view.revision) &&
    view.revision > 0 &&
    view.scale === 3 &&
    view.runtimeBuild === '24A434' &&
    ((view.pose === 'open' && view.width === 890 && view.height === 626) ||
      (view.pose === 'closed' && view.width === 466 && view.height === 678))
  );
}

/** VideoToolbox aligns encoded dimensions; allow that rounding when checking the decoded pose. */
export function matchesDuoVideo(view: DuoViewport, width: number, height: number): boolean {
  return width > 0 && height > 0 && Math.abs(width / height - view.width / view.height) < 0.015;
}

/** Old simulators receive unchanged messages. Duo touch messages carry their viewport revision. */
export function addDuoRevision(data: ArrayBuffer, view: DuoViewport): ArrayBuffer {
  const bytes = new Uint8Array(data);
  if (bytes[0] !== 2 && bytes[0] !== 18) return data;
  const output = new Uint8Array(data.byteLength + 4);
  output.set(bytes);
  new DataView(output.buffer).setUint32(data.byteLength, view.revision, true);
  return output.buffer;
}
