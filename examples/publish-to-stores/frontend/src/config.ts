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
 * The example backend; assumed to run on the same host. It mints the
 * short-lived scoped registry token the browser uses to open the Apple
 * relay directly against Limrun's registry — the API key never leaves the
 * backend.
 */
export const BACKEND_URL = 'http://localhost:3000';
