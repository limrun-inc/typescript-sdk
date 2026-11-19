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

/**
 * Plays an element that carries the simulator's speaker audio. Browsers
 * refuse sound outside a recent user gesture; the element then keeps playing
 * muted, so a later unmute from a click needs no new `play()`, and
 * `onBlocked` lets the caller show that the sound is off.
 */
export const playSpeaker = (audio: HTMLMediaElement, onBlocked: () => void): void => {
  void Promise.resolve(audio.play()).catch((error: unknown) => {
    if ((error as { name?: string } | null)?.name !== 'NotAllowedError' || audio.muted) return;
    audio.muted = true;
    void Promise.resolve(audio.play()).catch(() => undefined);
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
