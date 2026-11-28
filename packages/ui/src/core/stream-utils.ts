export const debugLog = (...args: any[]) => {
  if (window.debugRemoteControl) {
    console.log(...args);
  }
};

export const debugWarn = (...args: any[]) => {
  if (window.debugRemoteControl) {
    console.warn(...args);
  }
};

// Events that grant the page user activation, so play() with sound succeeds in their handlers.
const SPEAKER_GESTURES = ['click', 'keydown'] as const;
const speakerRetries = new WeakMap<HTMLMediaElement, () => void>();

/** Drops a pending retry, because the caller chose mute or unmute itself. */
export const cancelSpeakerRetry = (audio: HTMLMediaElement): void => {
  speakerRetries.get(audio)?.();
};

/**
 * Plays an element that carries the simulator's speaker audio. Browsers
 * refuse sound outside a recent user gesture; the element then keeps playing
 * muted, `onBlocked` lets the caller show that the sound is off, and the next
 * click or key press anywhere on the page turns the sound back on. A caller
 * that mutes in between cancels that with `cancelSpeakerRetry`.
 */
export const playSpeaker = (audio: HTMLMediaElement, onBlocked: () => void): void => {
  if (speakerRetries.has(audio)) {
    // A reconnect while the sound waits for a gesture keeps playing muted and keeps that retry.
    void Promise.resolve(audio.play()).catch(() => undefined);
    return;
  }
  void Promise.resolve(audio.play()).catch((error: unknown) => {
    if ((error as { name?: string } | null)?.name !== 'NotAllowedError' || audio.muted) return;
    audio.muted = true;
    void Promise.resolve(audio.play()).catch(() => undefined);
    const document = audio.ownerDocument;
    const retry = () => {
      cancel();
      audio.muted = false;
      playSpeaker(audio, onBlocked);
    };
    const cancel = () => {
      for (const type of SPEAKER_GESTURES) document.removeEventListener(type, retry, true);
      speakerRetries.delete(audio);
    };
    for (const type of SPEAKER_GESTURES) document.addEventListener(type, retry, true);
    speakerRetries.set(audio, cancel);
    onBlocked();
  });
};

// A failing host callback must not interrupt connection cleanup or message handling.
export const safeInvoke = <Args extends unknown[]>(
  label: string,
  fn: ((...args: Args) => unknown) | undefined,
  ...args: Args
): void => {
  if (!fn) return;
  try {
    fn(...args);
  } catch (err) {
    // Surface to the developer regardless of debug flag — this is a bug
    // in the customer's handler and they'll want to see it.
    console.error(`[RemoteControl] customer callback "${label}" threw:`, err);
  }
};

export type DevicePlatform = 'ios' | 'android' | 'macos';

export const detectPlatform = (url: string): DevicePlatform => {
  if (url.includes('/android_')) {
    return 'android';
  }
  if (url.includes('/macos_')) {
    return 'macos';
  }
  // Default to iOS if no Android pattern is found
  return 'ios';
};

// The endpoint may already carry query parameters, and the token may contain URL syntax.
export const withAuthenticationToken = (url: string, token: string): string => {
  const endpoint = new URL(url);
  endpoint.searchParams.set('token', token);
  return endpoint.toString();
};
