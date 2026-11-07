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

export type DevicePlatform = 'ios' | 'android';

export const detectPlatform = (url: string): DevicePlatform => {
  if (url.includes('/android_')) {
    return 'android';
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
