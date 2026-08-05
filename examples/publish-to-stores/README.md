# Publish to Stores

An end-to-end iOS and Android publishing example. Both flows launch a detached
CLI build, return a publish ID immediately, and show the terminal result from an
authenticated build-finish webhook. Persisted logs remain available through the
callback payload.

Device installation is intentionally separate; see
[`examples/device-install`](../device-install). The Connect checklist can
still prepare its signing material (see
[Device install credentials](#device-install-credentials)).

## Architecture

- `frontend/` uses `@limrun/apple-auth` to sign into Apple through Limrun's
  registry relay, choose or create a bundle ID, and choose Apple cloud signing
  or manual signing. It prepares the App Store Connect app record and Admin API
  key for either mode; manual mode also creates the distribution certificate
  and App Store provisioning profile. It can separately prepare
  device-install credentials covering the team's registered iPhones.
- The Android tab uses `@limrun/play-auth` for Google Identity Services and
  browser-side upload-keystore generation. It detects the package from the
  project, verifies Play Console access, then calls the backend with a
  short-lived Google access token.
- `backend/` keeps `LIM_API_KEY` server-side, mints a short-lived
  `applerelay:*:connect` scoped token, stores signing secrets as files under
  `backend/.secrets/`, runs a detached `lim xcode build` with the selected
  signing mode and `--upload-to-appstore`, and tracks the callback. Android
  follows the same
  pattern with detached `lim gradle build`: it signs `bundleRelease`, resolves
  the next Play `versionCode`, publishes the AAB, and reports completion by
  webhook.
- The webhook receiver listens separately on port 3001. Only its
  token-guarded route is exposed publicly, through the webhook URL entered
  in the UI; the secret store and token-minting routes remain local on
  port 3000.

The iOS publish uploads to App Store Connect. The uploaded build shows up in
TestFlight automatically; the success link opens the app's distribution page
where the processed build can be attached to a version and submitted for
review.

## iOS signing modes

The Connect phase makes the ownership of signing credentials explicit:

- **Apple cloud signing** uses only the App Store Connect API key from the
  configured secret store. `lim xcode build` exports with
  `--signing-method app-store-connect`; Apple creates, stores, and reuses the
  cloud-managed distribution certificate and provisioning profile.
- **Manual signing** creates and maintains the distribution certificate (p12)
  and App Store provisioning profile in the configured secret store. The
  backend materializes them only for the build and passes
  `--certificate-p12` and `--provisioning-profile`. The App Store Connect API
  key is still used for the upload.

Switching modes resets the Connect checklist to that mode's required resources.
The device-install certificate and profile actions remain optional and are
independent of the publishing mode.

## Device install credentials

The certificate and device-profile Connect actions create what the
[`device-install`](../device-install) example needs: a development
certificate (WebUSB installs) and ad-hoc/development provisioning profiles
(QR code and WebUSB installs) bound to the iPhones already registered on the
team. Device-bound profiles must list every device they cover, so Connect
recreates them when the registered device set or the signing certificate
changes, and skips them with a note when the team has no registered devices
yet — the device-install example registers an iPhone and creates its profile
on first use.

Each example backend stores secrets under its own `backend/.secrets/` by
default. The UI has a "Secrets directory" field, pre-filled with the
backend's current default (`backend/.secrets/`, or `SECRETS_DIR` when the
backend was started with it); every store operation and publish uses the
entered directory. Enter the same directory in both examples to share the
material. With a shared store, an iPhone covered by the profiles created
here installs through the device-install example without another Apple
sign-in.

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
The backend passes it to the CLI through `LIM_PLAYSTORE_ACCESS_TOKEN`, keeping
it out of command arguments and shell history. Both build types request a fresh
instance with a 3-second inactivity timeout; active builds count as activity.
Replace `GOOGLE_OAUTH_CLIENT_ID` in `frontend/src/config.ts` when serving from
an origin other than `http://localhost:5173`.

## Requirements

- Node.js and Yarn 1
- The `lim` CLI on `PATH`
- `LIM_API_KEY`
- A public HTTPS URL that forwards to the webhook receiver on port 3001,
  entered in the UI (see [Webhook URL](#webhook-url))
- An Apple Developer Program account with permission to create App Store
  Connect API keys
- For Apple cloud signing, an Admin API key or one with **Access to
  cloud-managed distribution certificates**
- A Google Play Console app and a Google account with release permission

## Webhook URL

Builds run inside Limrun's cloud and report completion by POSTing a webhook,
so the receiver on port 3001 must be reachable from the internet — limbuild
rejects private and IP-literal callback URLs. Bring your own public URL and
paste it into the UI's Webhook URL field (top of the sidebar); it rides each
publish request and is used verbatim as the callback URL, nothing is
appended:

- [ngrok](https://ngrok.com): run `ngrok http 3001` and use the printed
  `https://….ngrok-free.app` URL. The webhook reaches the backend and the
  wizard shows the result.
- [requestbin.net](https://requestbin.net) (or any request-inspection
  service): use the bin URL to see the raw webhook payload. Note that the
  payload never reaches this backend then, so the wizard keeps waiting; use
  this only to inspect what limbuild sends.

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

Open `http://localhost:5173` and enter the webhook URL at the top of the
sidebar (e.g. from `ngrok http 3001`). Use the iOS tab for Apple setup and
an App Store publish. Use the Android tab to select a project, verify its
Play listing, prepare the upload key, and publish. The build result panel
shows the arrived webhook payload JSON verbatim.

The backend passes a random per-publish `X-Publish-Token` to limbuild and
matches the incoming webhook to its publish by that header alone; requests
without a matching token receive a 404.

`backend/.secrets/` contains private keys and is gitignored. The in-memory
publish registry is demo-only and is lost when the backend restarts.
