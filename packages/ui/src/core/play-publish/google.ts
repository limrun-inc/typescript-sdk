const GSI_SRC = 'https://accounts.google.com/gsi/client';

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

type TokenResponse = { access_token?: string; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: () => void };
type GoogleOAuth2 = {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: TokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }) => TokenClient;
};

function googleOAuth2(): GoogleOAuth2 | undefined {
  return (globalThis as { google?: { accounts?: { oauth2?: GoogleOAuth2 } } }).google?.accounts?.oauth2;
}

let gsiLoad: Promise<void> | undefined;

export function loadGoogleIdentityServices(): Promise<void> {
  if (googleOAuth2()) {
    return Promise.resolve();
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('Google sign-in requires a browser environment.'));
  }
  if (!gsiLoad) {
    gsiLoad = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.addEventListener(
        'load',
        () => {
          if (googleOAuth2()) {
            resolve();
          } else {
            reject(new Error('Google sign-in script loaded without the OAuth client.'));
          }
        },
        { once: true },
      );
      script.addEventListener(
        'error',
        () => {
          script.remove();
          reject(new Error('Failed to load the Google sign-in script.'));
        },
        { once: true },
      );
      document.head.appendChild(script);
    });
    // A failed load (offline, blocked CDN) must not poison retries.
    gsiLoad.catch(() => {
      gsiLoad = undefined;
    });
  }
  return gsiLoad;
}

export type RequestGoogleAccessTokenInput = {
  clientId: string;
  scope?: string;
};

/**
 * Opens the Google consent popup and resolves with a short-lived OAuth
 * access token. Call from a user gesture so popup blockers allow it, and
 * call loadGoogleIdentityServices beforehand (e.g. when the surrounding
 * dialog opens) to keep this call synchronous with the click.
 */
export function requestGoogleAccessToken(input: RequestGoogleAccessTokenInput): Promise<string> {
  // When GSI is already loaded the popup must open inside the caller's
  // click turn: even an await of a resolved promise yields a microtask,
  // which the strictest popup blockers treat as leaving the gesture.
  if (googleOAuth2()) {
    return openTokenPopup(input);
  }
  return loadGoogleIdentityServices().then(() => openTokenPopup(input));
}

function openTokenPopup({
  clientId,
  scope = ANDROID_PUBLISHER_SCOPE,
}: RequestGoogleAccessTokenInput): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = googleOAuth2()!.initTokenClient({
      client_id: clientId,
      scope,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        if (!response.access_token) {
          reject(new Error('Google returned no access token.'));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: (error) => {
        const fallback =
          error?.type === 'popup_failed_to_open' ?
            'Google sign-in popup was blocked by the browser.'
          : 'Google sign-in was cancelled.';
        reject(new Error(error?.message || fallback));
      },
    });
    client.requestAccessToken();
  });
}
