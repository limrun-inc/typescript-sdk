# Publish to Stores

An end-to-end iOS and Android publishing example. The iOS flow signs into
Apple, prepares App Store credentials, and runs a detached `lim xcode build`;
the terminal result arrives through an authenticated build-finish webhook. The
Android flow signs into Google, builds and signs an AAB remotely, and publishes
it to Google Play while streaming the build log.

Device installation is intentionally separate; see
[`examples/device-install`](../device-install).

## Architecture

- `frontend/` uses `@limrun/apple-auth` to sign into Apple through Limrun's
  registry relay, choose or create a bundle ID, and prepare exactly four
  resources: an Apple distribution certificate, App Store provisioning
  profile, App Store Connect app record, and App Store Connect API key.
- The Android tab uses `@limrun/play-auth` for Google Identity Services and
  browser-side upload-keystore generation. It detects the package from the
  project, verifies Play Console access, then calls the backend with a
  short-lived Google access token.
- `backend/` keeps `LIM_API_KEY` server-side, mints a short-lived
  `applerelay:*:connect` scoped token, stores signing secrets as files under
  `backend/.secrets/`, runs `lim xcode build --detach
  --upload-to-testflight`, and tracks the callback. For Android it creates a
  one-shot Gradle instance, syncs the project, signs `bundleRelease`, and
  publishes through the Gradle Play stage.
- The webhook receiver listens separately on port 3001. Only its
  token-guarded route is exposed through localtunnel (or `PUBLIC_URL`); the
  secret store and token-minting routes remain local on port 3000.

Both UI choices upload to App Store Connect. TestFlight links to the uploaded
builds; App Store links to the distribution page where the processed build can
be attached to a version and submitted for review.

## Google Play flow

Google does not allow API clients to create the Play Console app listing, so
create it once with the exact package name and grant the signed-in Google
account release access. The wizard then:

1. Detects the package name from Expo `app.json` or Gradle build files.
2. Signs into Google with the `androidpublisher` scope and verifies the app.
3. Reuses an existing upload keystore or generates one in the browser. The
   private key only leaves the browser when written to the configured
   `SigningSecretStore`.
4. Resolves the next free `versionCode`, builds a signed AAB, uploads it as a
   Limrun asset, and publishes it to the internal track.

The Google access token rides only the publish request and is never stored.
Replace `GOOGLE_OAUTH_CLIENT_ID` in `frontend/src/config.ts` when serving from
an origin other than `http://localhost:5173`.

## Requirements

- Node.js and Yarn 1
- The `lim` CLI on `PATH`
- `LIM_API_KEY`
- An Apple Developer Program account with permission to create App Store
  Connect API keys
- A Google Play Console app and a Google account with release permission

## Run

```bash
export LIM_API_KEY="your api key"
yarn --cwd examples/publish-to-stores/backend install
yarn --cwd examples/publish-to-stores/frontend install
yarn --cwd examples/publish-to-stores/backend dev
```

In another terminal:

```bash
yarn --cwd examples/publish-to-stores/frontend dev
```

Open `http://localhost:5173`. Use the iOS tab for Apple setup and a TestFlight
or App Store publish. Use the Android tab to select a project, verify its Play
listing, prepare the upload key, and publish.

Set `PUBLIC_URL` to a public HTTPS URL forwarded to port 3001 to replace the
automatic localtunnel. The backend passes both a random per-publish
`X-Publish-Token` and `Bypass-Tunnel-Reminder=true` to limbuild; invalid tokens
receive the same 404 as unknown publish IDs.

`backend/.secrets/` contains private keys and is gitignored. The in-memory
publish registry is demo-only and is lost when the backend restarts.
