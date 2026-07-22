/**
 * Publisher branding. Every artifact this example creates on Apple's side
 * (certificate common names, provisioning profile names, App Store Connect
 * API key nickname) is derived from PUBLISHER_NAME, so rebranding the whole
 * pipeline is a one-line change. None of the underlying `@limrun/apple-auth` APIs
 * bake in a default name.
 */
export const PUBLISHER_NAME = 'Acme Publisher';

export const naming = {
  certificateCommonName: (teamId: string) => `${PUBLISHER_NAME} ${teamId}`,
  appStoreProfileName: (bundleId: string) => `${PUBLISHER_NAME} App Store ${bundleId}`,
  apiKeyNickname: `${PUBLISHER_NAME} Publishing`,
};

/**
 * The example backend; assumed to run on the same host. It mints the
 * short-lived scoped registry token the browser uses to open the Apple
 * relay directly against Limrun's registry — the API key never leaves the
 * backend.
 */
export const BACKEND_URL = 'http://localhost:3000';

/**
 * Google OAuth "Web application" client ID for the Play publish sign-in.
 * A client ID is public (the token model uses no client secret), but its
 * authorized JavaScript origins must include this app's origin; this one
 * whitelists http://localhost:5173. Replace it with your own client ID
 * when serving from any other origin.
 */
export const GOOGLE_OAUTH_CLIENT_ID =
  '55460095094-d6q9j3op8dsqmahet2d1sil6cudmpfqn.apps.googleusercontent.com';
