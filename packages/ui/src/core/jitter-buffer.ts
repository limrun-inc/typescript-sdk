/** Set a playback preference without letting browser support interrupt the stream. */
export function applyJitterBufferTarget(receiver: RTCRtpReceiver, targetMs: number | null | undefined): void {
  if (targetMs != null && (!Number.isFinite(targetMs) || targetMs < 0 || targetMs > 4000)) {
    console.warn('RemoteControl: jitterBufferTargetMs must be a finite number between 0 and 4000.');
    return;
  }
  if (!('jitterBufferTarget' in receiver)) return;

  const target = targetMs ?? null;
  try {
    if (receiver.jitterBufferTarget !== target) {
      receiver.jitterBufferTarget = target;
    }
  } catch (error) {
    console.warn('RemoteControl: could not set the jitter buffer target.', error);
  }
}
