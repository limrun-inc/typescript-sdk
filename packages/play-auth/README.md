# @limrun/play-auth

Headless building blocks for publishing an AAB asset from the Limrun
registry to Google Play, with browser and Desktop OAuth sign-in. No UI ships
here; embedders render their own buttons and dialogs around the hook,
same as `device-install`.

The Google access token is minted in the browser via Google Identity
Services (token model, no client secret) and sent to the registry once
per publish. Limrun never stores it.

## Browser requirements

- A Google OAuth **Web application** client ID whose authorized
  JavaScript origins include your app's origin.
- The signed-in Google account needs release permission for the target
  app in Play Console, and the app listing must already exist.
- The asset must be an AAB signed with the app's Play upload key.

## Sign in from a CLI or desktop app

Use the same `@limrun/play-auth` import in Node.js 18 or later or the Node
process of a desktop app. Browser code continues to use
`requestGoogleAccessToken`; the Desktop flow opens the system browser and
receives the authorization code on a temporary `127.0.0.1` listener.

Create a Google OAuth client with application type **Desktop app**, enable the
Google Play Android Developer API in its project, and download the client JSON.
Configure the consent screen and any required test users. A Web application
client cannot be substituted for the Desktop client.

```ts
import { readFile } from 'node:fs/promises';
import open from 'open';
import {
  authenticateGoogleDesktop,
  parseGoogleDesktopClient,
  refreshGoogleAccessToken,
} from '@limrun/play-auth';

const client = parseGoogleDesktopClient(JSON.parse(await readFile('client_secret.json', 'utf8')));
const tokens = await authenticateGoogleDesktop({ ...client, openBrowser: open });
// Store the client configuration and tokens.refreshToken in your credential store.
// tokens.accessToken can be passed to publishToPlaystore.

const refreshed = await refreshGoogleAccessToken({
  ...client,
  refreshToken: tokens.refreshToken,
});
// Save a replacement refreshToken if Google returns one; otherwise keep the old one.
```

For experimental Console operations, pass `consoleScope: PLAY_CONSOLE_SCOPE`
or `consoleScope: PLAY_DEVELOPER_APP_SCOPE` only after Google approves that scope
for the client. The Desktop flow requests it alongside `ANDROID_PUBLISHER_SCOPE`.

`authenticateGoogleDesktop` uses PKCE and a random state value, requests offline
access to the Android Publisher scope, and requires a refresh token in the
response. Pass `signal` to cancel or `timeoutMs` to change the five-minute
browser callback deadline. Both token helpers return `expiresAt` as Unix time
in milliseconds. They do not write files or store credentials in Limrun.

Run the process on the same computer as the browser. In Electron, call the
Desktop flow from the main process and pass a system-browser opener. For the
Limrun CLI, use `lim android play auth --client-config client_secret.json`.

## React

```tsx
import { usePlaystorePublish } from '@limrun/play-auth/react';

const play = usePlaystorePublish({
  registryApiUrl: 'https://registry.limrun.com',
  token: limrunToken,
  organizationId: organizationTid,
  googleClientId: GOOGLE_OAUTH_CLIENT_ID,
});

// On dialog open, warm the sign-in script so the click stays popup-safe.
// Optionally await the returned promise (true = ready) to gate the button:
play.preloadGoogle();

// Button handlers:
await play.signInWithGoogle();
await play.publish({ assetName: 'app-release.aab', packageName: 'com.example.app' });

// Render from state: play.status, play.versionCode, play.error, play.errorCode
```

`errorCode` carries the registry's machine-readable error code; the
canonical value list lives on `PlaystorePublishError`'s doc comment and
grows additively.

Google access tokens expire after about an hour. A `permissionDenied`
error long after sign-in usually means the token expired; offer "Sign in
with Google" again rather than pointing users at Play Console
permissions.

## Upload keystore custody

Persistent signing material such as the Play upload keystore stays under
the caller's control through `SigningSecretStore`, the same pluggable
interface `@limrun/apple-auth` uses for Apple material (the two are
structurally identical, so one store instance can serve both). Generate a
keystore in the browser and escrow it in whichever store you choose:

```ts
import {
  createLimrunSecretStore,
  generateAndroidUploadKeystore,
  putAndroidSigningKeySecret,
} from '@limrun/play-auth';

const store = createLimrunSecretStore({ apiUrl, token, organizationId }); // or your own
const keystore = await generateAndroidUploadKeystore('com.example.app');
await putAndroidSigningKeySecret(store, 'com.example.app', keystore);
```

`createLimrunSecretStore` escrows in Limrun's organization secret store,
which is where `lim gradle build --sign` looks the key up (named by the
bare application ID). Applications that keep secrets themselves implement
the interface over their own storage — a database, a KMS, anything; the
publish-to-stores example backs it with its example backend's file store.

## Without React

```ts
import { requestGoogleAccessToken, publishToPlaystore } from '@limrun/play-auth';

const accessToken = await requestGoogleAccessToken({ clientId: GOOGLE_OAUTH_CLIENT_ID });
const { versionCode } = await publishToPlaystore({
  registryApiUrl,
  token,
  organizationId,
  accessToken,
  assetName: 'app-release.aab',
  packageName: 'com.example.app',
});
```

## Experimental app creation

Google must approve your OAuth client for `PLAY_CONSOLE_SCOPE`
(`https://www.googleapis.com/auth/play_console`) or `PLAY_DEVELOPER_APP_SCOPE`
(`https://www.googleapis.com/auth/playdeveloperapp`). Request only the scope Google
approves, alongside `ANDROID_PUBLISHER_SCOPE` for publishing. Ordinary clients get
`invalid_scope`; `androidpublisher` alone cannot authorize creation.

This uses an undocumented API. **The OAuth flow is not yet verified end to end
with an approved client.** Both functions use `fetch` directly against Google and
can run in a browser or server environment.

```ts
import { createPlayConsoleApp, enrollPlayAppSigning } from '@limrun/play-auth';

const app = await createPlayConsoleApp({
  accessToken, // Obtained with a Google-approved Console scope.
  developerId, // Numeric developer account ID, as a string.
  packageName: 'com.example.app',
  title: 'Example',
  defaultLanguage: 'en-US',
  appType: 'app',
  paid: false,
  appMeetsGuidelines: form.appMeetsGuidelines,
  usExportCompliant: form.usExportCompliant,
});
// Retain this app reference if enrollment fails; retry enrollment only.
await enrollPlayAppSigning({ accessToken, ...app });
```

Collect both declarations from the user. Creation registers a draft and package;
enrollment asks Google to manage its distribution signing key. Neither publishes
a release. Tokens are not persisted, and requests are never retried automatically.
`PlayConsoleError` exposes `status` and `outcomeUnknown`. Check the developer account
before retrying creation with an unknown outcome. An optional `signal` cancels the
request but cannot undo a mutation.
