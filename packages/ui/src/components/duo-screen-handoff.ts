/** Capture two bounded stills per fold, without retaining a canvas or rendering loop. */
export function captureDuoFrame(
  video: HTMLVideoElement | null,
  rejectBlank = false,
): HTMLCanvasElement | undefined {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const ratio = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  try {
    const context = canvas.getContext('2d');
    if (!context) return;
    if (rejectBlank) {
      // Display switching can decode a black frame before iOS presents its new layout.
      canvas.width = canvas.height = 32;
      context.drawImage(video, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      if (!pixels.some((value, index) => index % 4 !== 3 && value > 16)) return;
    }
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return;
  }
}

/** Wait for the incoming display to present content, with a bound for deliberately black apps. */
export function waitForDuoFrame(
  video: HTMLVideoElement | null,
  ready: (image: HTMLCanvasElement | undefined) => void,
) {
  let stopped = false;
  let callback: number | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const finish = (image: HTMLCanvasElement | undefined) => {
    if (stopped) return;
    stop();
    ready(image);
  };
  const probe = document.createElement('canvas');
  probe.width = probe.height = 32;
  const context = probe.getContext('2d', { willReadFrequently: true });
  let previous = -1;
  let stable = 0;
  let samples = 0;
  const sample = () => {
    if (stopped) return;
    let brightness = 0;
    try {
      if (!video || video.readyState < 2 || !context) throw new Error('No decoded frame');
      context.drawImage(video, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      for (let i = 0; i < pixels.length; i += 4)
        brightness += Math.max(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      brightness /= pixels.length / 4;
    } catch {
      brightness = 0;
    }
    samples++;
    stable =
      brightness > 4 && Math.abs(brightness - previous) < Math.max(1, brightness * 0.03) ? stable + 1 : 0;
    previous = brightness;
    // Native display fades last longer than its first decoded frame. Wait for the fade to settle.
    if (samples >= 4 && stable >= 2) {
      const image = captureDuoFrame(video, true);
      if (image) {
        finish(image);
        return;
      }
    }
    settle = setTimeout(sample, 100);
  };
  const available = () => {
    if (stopped || settle !== undefined) return;
    settle = setTimeout(sample, 300);
  };
  callback = video?.requestVideoFrameCallback?.(available);
  video?.addEventListener('loadeddata', available);
  // Older browsers have no video-frame callback; sampling still runs only during the handoff.
  if (!video?.requestVideoFrameCallback && video && video.readyState >= 2) available();
  const fallback = setTimeout(() => finish(captureDuoFrame(video)), 2500);
  function stop() {
    stopped = true;
    clearTimeout(settle);
    clearTimeout(fallback);
    if (callback !== undefined) video?.cancelVideoFrameCallback(callback);
    video?.removeEventListener('loadeddata', available);
  }
  return stop;
}
