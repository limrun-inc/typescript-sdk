import type { Ios } from '@limrun/api';

/**
 * Renders an iOS hang report as human-readable text. A sample gives one line on how long the main
 * thread has been stuck and what it was doing, then the top of its stack; a hang's end gives one
 * line with its length.
 */
export function formatAppHang(appId: string, hang: Ios.AppHangInfo, frames = 8): string {
  const which = `hang ${hang.hangId}, pid ${hang.pid}`;
  if (hang.ended) return `${appId} main thread hang ended after ${hang.durationMs} ms (${which})`;

  const usage = [which];
  if (hang.mainThreadState) usage.push(hang.mainThreadState);
  if (hang.mainThreadCpuMs !== undefined) {
    const kernel = hang.mainThreadKernelMs !== undefined ? ` (${hang.mainThreadKernelMs} ms in kernel)` : '';
    usage.push(`main thread cpu ${hang.mainThreadCpuMs} ms${kernel}`);
  }
  if (hang.appCpuMs !== undefined) usage.push(`app cpu ${hang.appCpuMs} ms`);
  if (hang.pageIns !== undefined) usage.push(`page-ins ${hang.pageIns}`);
  if (hang.footprintBytes !== undefined)
    usage.push(`footprint ${Math.round(hang.footprintBytes / 2 ** 20)} MB`);

  const lines = [`${appId} main thread unresponsive for ${hang.durationMs} ms (${usage.join(', ')})`];
  // The stack opens with a "Main Thread:" title and ends its frames at a blank line before the images.
  const stack = (hang.stackTrace ?? '').split('\n').slice(1);
  const end = stack.indexOf('');
  lines.push(...stack.slice(0, Math.min(frames, end < 0 ? stack.length : end)).map((frame) => `  ${frame}`));
  return lines.join('\n');
}
