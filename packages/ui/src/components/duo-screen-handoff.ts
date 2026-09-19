/** Capture two bounded stills per fold, without retaining a canvas or rendering loop. */
export function captureDuoFrame(video: HTMLVideoElement | null): HTMLCanvasElement | undefined {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const ratio = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  try {
    const context = canvas.getContext('2d');
    if (!context) return;
    canvas.width = Math.round(video.videoWidth * ratio);
    canvas.height = Math.round(video.videoHeight * ratio);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return;
  }
}

/** Capture the first incoming frame without delaying for native fades or brightness changes. */
export function waitForDuoFrame(
  video: HTMLVideoElement | null,
  ready: (image: HTMLCanvasElement | undefined) => void,
) {
  let stopped = false;
  let callback: number | undefined;
  const finish = (image: HTMLCanvasElement | undefined) => {
    if (stopped) return;
    stop();
    ready(image);
  };
  const available = () => {
    if (!stopped) finish(captureDuoFrame(video));
  };
  // Release the held image if the incoming stream never delivers a frame.
  const fallback = setTimeout(() => finish(undefined), 2500);
  callback = video?.requestVideoFrameCallback?.(available);
  video?.addEventListener('loadeddata', available);
  if (!video?.requestVideoFrameCallback && video && video.readyState >= 2) available();
  function stop() {
    stopped = true;
    clearTimeout(fallback);
    if (callback !== undefined) video?.cancelVideoFrameCallback(callback);
    video?.removeEventListener('loadeddata', available);
  }
  return stop;
}
