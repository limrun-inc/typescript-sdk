/**
 * Publisher branding. Every artifact this example creates on Apple's side
 * (certificate common names, provisioning profile names, App Store Connect
 * API key nickname) is derived from PUBLISHER_NAME, so rebranding the whole
 * pipeline is a one-line change. None of the underlying `@limrun/ui` APIs
 * bake in a default name.
 */
export const PUBLISHER_NAME = 'Acme Publisher';

export const naming = {
  certificateCommonName: (teamId: string) => `${PUBLISHER_NAME} ${teamId}`,
  developmentProfileName: (bundleId: string) => `${PUBLISHER_NAME} Development ${bundleId}`,
  adHocProfileName: (bundleId: string) => `${PUBLISHER_NAME} Ad Hoc ${bundleId}`,
  appStoreProfileName: (bundleId: string) => `${PUBLISHER_NAME} App Store ${bundleId}`,
  apiKeyNickname: `${PUBLISHER_NAME} Publishing`,
};

/**
 * The example backend; assumed to run on the same host. It also serves the
 * Apple relay WebSocket by piping it to Limrun's registry with the API key
 * attached server-side, so no Limrun credential ever reaches the browser.
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
