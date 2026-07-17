# @limrun/ui/play-publish

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
import { usePlaystorePublish } from '@limrun/ui/play-publish/react';

const play = usePlaystorePublish({
  registryApiUrl: 'https://registry.limrun.com',
  token: limrunToken,
  organizationId: organizationTid,
  googleClientId: GOOGLE_OAUTH_CLIENT_ID,
});

// On dialog open, warm the sign-in script so the click stays popup-safe:
play.preloadGoogle();

// Button handlers:
await play.signInWithGoogle();
await play.publish({ assetName: 'app-release.aab', packageName: 'com.example.app' });

// Render from state: play.status, play.versionCode, play.error, play.errorCode
```

`errorCode` values: `invalidRequest`, `assetNotFound`, `internal`, `busy`,
`listingNotFound`, `permissionDenied`, `versionCodeExists`,
`uploadKeyMismatch`, `unknown`. The set grows additively.

Google access tokens expire after about an hour. A `permissionDenied`
error long after sign-in usually means the token expired; offer "Sign in
with Google" again rather than pointing users at Play Console
permissions.

## Without React

```ts
import { requestGoogleAccessToken, publishToPlaystore } from '@limrun/ui/play-publish';

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
