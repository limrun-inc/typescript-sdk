# Publish to Stores

A Replit-style publishing pipeline for iOS apps: a two-phase wizard that connects an Apple
Developer account once, then publishes builds to TestFlight, the App Store, or a paired
iPhone over WebUSB. The outcome arrives as a **build-finish webhook**: the UI shows
"Waiting for build callback" while the build runs remotely, then renders the webhook
payload and how long the build took. WebUSB builds continue into automatic installation.

It has two components:

- `backend/`: Stores signing secrets as files under `backend/.secrets/`, runs
  `lim xcode build --upload-to-testflight` for publishes, opens a
  **[localtunnel](https://github.com/localtunnel/localtunnel)** (no account or token
  needed) in front of the webhook receiver — a separate Express app that serves nothing
  but the token-guarded webhook route, so the secret store is never publicly reachable —
  and mints short-lived **scoped registry tokens** with `limrun.scopedTokens.create`
  from `@limrun/api`. Your API key stays server-side; the browser only ever holds a
  narrowly scoped tokens for Apple login, WebUSB pairing, and one built IPA. Every token
  expires on its own.
- `frontend/`: The wizard. **Connect** signs into Apple with `@limrun/apple-auth`
  over the Apple relay — talking to Limrun's registry **directly** with the scoped
  token, no proxying — registers the bundle ID, mints development and distribution
  certificates, provisioning profiles (development, ad-hoc, App Store), the App Store
  Connect app record, and an App Store Connect API key — all stored through the backend.
  `@limrun/device-install@^0.1.0` selects and pairs an iPhone, while
  `@limrun/apple-auth@^0.1.0` registers its UDID and refreshes development signing.
  **Publish** unlocks afterwards and triggers the upload or device install.

No Xcode instance exists until a publish runs: the Apple relay lives on Limrun's registry
edge and is not tied to any instance, and `lim xcode build` provisions (or reuses) its own
instance when a publish actually starts.

## How it works

```
Frontend wizard ──Apple relay ws (scoped token)──> Limrun registry ──> Apple
      │                                (Developer Portal + App Store Connect)
      ├──session──> Backend POST /session ──mints──> scoped token (applerelay:*:connect)
      ├──secrets──> Backend file store (backend/.secrets/)
      ├──publish──> Backend POST /publish ──spawns──> lim xcode build --webhook-url ...
      ├──device───> Backend POST /device-session ──mints──> device[:asset] token
      └──poll────> Backend GET /publish/:id <──webhook (via tunnel)── limbuild (build done)
```

- The backend exposes `POST /session`, which calls `limrun.scopedTokens.create` with the
  `applerelay:*:connect` scope. Scopes have the form `<resource>:<id|*>:<action>`; this
  token can open the Apple relay and nothing else. Tokens default to a 1 hour TTL and
  cannot be revoked, so keep them short-lived.
- WebUSB uses a separate `POST /device-session`. Before the build, it mints only
  `device:*:install`, which is enough to pair the selected iPhone. After a successful
  WebUSB webhook, the frontend exchanges the publish ID for a fresh token containing
  `device:*:install` plus only `asset:<uploaded-asset-id>:read`. The browser never gets
  general asset-listing or organization authority.
- Apple credentials never touch the example backend during Connect: the browser talks to
  Apple through Limrun's relay directly (authenticated with the scoped token — the API
  key never reaches the browser) and writes the resulting signing material into the
  secret store.
- The secret store is deliberately pluggable. The backend's file store implements the same
  REST shape as Limrun's organization secrets API, and the frontend wraps it in a
  `SigningSecretStore` (`frontend/src/lib/backend.ts`). Swap it for
  `createLimrunSecretStore` from `@limrun/apple-auth` or your own database
  without touching the wizard.
- Publishing runs entirely server-side: the backend materializes the stored certificate,
  App Store profile, and App Store Connect API key into temp files and spawns the CLI with
  `--auto-build-number --inactivity-timeout 3s --detach`. The build number is incremented
  against App Store Connect automatically, the CLI returns as soon as limbuild accepts the
  build, and the fresh one-shot Xcode instance is reaped shortly after its last activity.
  The inactivity controller checks every 15 seconds, so a 3-second timeout means teardown
  typically occurs 3–18 seconds after the build and upload stop reporting activity; it
  cannot interrupt an active build.
- WebUSB prepares the selected device before building. The wizard reuses a stored
  development profile when it already includes the iPhone; otherwise it asks the user to
  sign in with Apple again, registers the UDID, ensures a development certificate, and
  stores a fresh device-specific profile. The backend then runs the same detached build
  with that development signing and `--upload webusb-<bundle-id>-<publish-id>.ipa`.
  Once the success webhook arrives, the frontend mints the exact asset grant and
  automatically starts installation through the existing pair record.
- The publish outcome travels as a webhook, not a log stream. The backend passes
  `--webhook-url https://<tunnel>/webhook/<id>` (plus a per-publish secret via
  `--webhook-header X-Publish-Token=...`) to the CLI; when the build reaches a terminal
  state, limbuild POSTs a JSON payload carrying the status, timings (`buildDurationMs`),
  a Limrun Console debug link, and a presigned URL for the persisted build log. The
  frontend polls `GET /publish/:id` and, once the callback lands, shows the payload and
  the build time. Because the CLI runs with `--detach`, it does not keep an SSE log stream
  open while the build runs.
- Both the TestFlight and App Store methods run the same upload. An App Store release is
  that upload plus attaching the processed build to a version and submitting it for review
  in App Store Connect.

## Branding

Every artifact created on Apple's side (certificate common names, profile names, the API
key nickname) derives from `PUBLISHER_NAME` in `frontend/src/config.ts`. Rebrand the whole
pipeline by changing that one constant; none of the underlying APIs bake in a default.

## Prerequisites

- A Limrun API key from `Limrun Console` > `Settings` [here](https://console.limrun.com/settings).
- The `lim` CLI version 0.21.1 or newer installed on the backend host's PATH:
  ```bash
  npm install -g lim@latest
  lim --version
  ```
  The backend invokes the first `lim` on `PATH`, so update or remove any older
  installation that shadows 0.21.1. Its `lim xcode build --help` output must include
  `--detach`, `--inactivity-timeout`, and `--upload`.
- An Apple Developer Program account (Admin role, required to create App Store Connect
  API keys).
- WebUSB publishing requires desktop Chromium in a secure context. `http://localhost`
  counts as secure for local development; a non-local deployment must use HTTPS. Connect
  an unlocked iPhone directly by USB, accept the browser device picker, and tap **Trust**
  on the iPhone when prompted. Safari and Firefox do not expose WebUSB.
- An iOS project on the backend host. The auto-incremented build number reaches the binary
  through `expo.ios.buildNumber` in `app.json` for Expo projects (written before prebuild)
  and through `CURRENT_PROJECT_VERSION` for projects on Xcode's standard versioning.

## Quick Start

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
```

1. Make your API key available as environment variable. The backend uses it to mint
   scoped registry tokens against `https://registry.limrun.com` (override with
   `LIM_REGISTRY_ENDPOINT`) and passes it to the `lim` CLI for builds.
   ```bash
   export LIM_API_KEY="your api key"
   ```
1. Start the backend. On boot it opens a localtunnel for the webhook receiver —
   limbuild rejects private and IP-literal callback URLs, so a public HTTPS front is
   required, and localtunnel provides one with no account or token. Only the webhook
   receiver (port 3001) is tunneled; the main API and secret store stay local. If you
   already have a public URL forwarded to port 3001 (your own ngrok, a reverse proxy),
   set `PUBLIC_URL` to it instead.
   ```bash
   yarn --cwd examples/publish-to-stores/backend install
   yarn --cwd examples/publish-to-stores/backend run dev
   ```
1. In another terminal session, start the frontend.
   ```bash
   yarn --cwd examples/publish-to-stores/frontend install
   yarn --cwd examples/publish-to-stores/frontend run dev
   ```
1. Go to `localhost:5173` and walk through Connect, then Publish. After signing in, the
   wizard lists the team's existing bundle IDs so you can pick one, or register a new one.
   The path of your iOS project is asked in the Publish step, where the build needs it.
   While the build runs, the main panel shows "Waiting for build callback"; when limbuild's
   webhook lands, it shows the payload JSON, the build duration, and links to the Limrun
   Console and the persisted build log.
1. For WebUSB, choose **Select iPhone**, pair it, and prepare signing. If the stored
   profile does not include that UDID, the Connect section asks for Apple sign-in and 2FA
   again without discarding the stored team, bundle ID, app record, or other credentials.
   Prepare the device again after authentication, then publish. Keep the iPhone connected
   and unlocked: after the webhook succeeds, the browser receives a token for that one IPA
   and starts installation automatically.

## Notes

- For Expo projects, a publish searches the project for the Expo `app.json` (monorepo
  layouts like `artifacts/mobile/app.json` included): when `expo.ios.bundleIdentifier`
  is missing, the backend fills it with the bundle ID chosen in the wizard (and says so
  in its terminal output), because Expo would otherwise prebuild the app under a
  placeholder like `com.anonymous.<slug>`. An existing value is never overwritten; if it
  differs from the chosen bundle ID, the backend logs a warning.

- Connect is one-time: on the next visit the wizard sees the stored secrets and jumps
  straight to Publish. "Disconnect and start over" clears the association (stored secrets
  are reused where possible on reconnect, so no duplicate certificates or keys are minted).
- Development and ad-hoc profiles bind registered devices, so those initial Connect
  actions are skipped with a note when the team has none. WebUSB can register a selected
  iPhone later and mint its own development profile; QR remains disabled.
- `backend/.secrets/` holds real signing material (private keys, the App Store Connect
  API key). It is gitignored; treat it accordingly.
