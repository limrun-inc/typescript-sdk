# @limrun/play-auth

Headless building blocks for publishing an AAB asset from the Limrun
registry to Google Play, with a browser-owned Google sign-in. No UI ships
here; embedders render their own buttons and dialogs around the hook,
same as `device-install`.

The Google access token is minted in the browser via Google Identity
Services (token model, no client secret) and sent to the registry once
per publish. Limrun never stores it.

## Requirements

- A Google OAuth **Web application** client ID whose authorized
  JavaScript origins include your app's origin.
- The signed-in Google account needs release permission for the target
  app in Play Console, and the app listing must already exist.
- The asset must be an AAB signed with the app's Play upload key.

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
