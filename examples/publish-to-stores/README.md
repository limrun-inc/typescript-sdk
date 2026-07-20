# Publish to Stores

A Replit-style publishing pipeline for iOS apps: a two-phase wizard that connects an Apple
Developer account once, then publishes builds to TestFlight or the App Store with a single
click, streaming the build log to the browser.

It has two components:

- `backend/`: Stores signing secrets as files under `backend/.secrets/`, runs
  `lim xcode build --upload-to-testflight` for publishes (streaming output over
  Server-Sent Events), and pipes the Apple relay WebSocket to Limrun's registry with the
  API key attached server-side so the browser never holds a Limrun credential.
- `frontend/`: The wizard. **Connect** signs into Apple with `@limrun/ui` components
  over the Apple relay, registers the bundle ID, mints development and distribution
  certificates, provisioning profiles (development, ad-hoc, App Store), the App Store
  Connect app record, and an App Store Connect API key — all stored through the backend.
  **Publish** unlocks afterwards and triggers the upload.

No Xcode instance exists until a publish runs: the Apple relay lives on Limrun's registry
edge and is not tied to any instance, and `lim xcode build` provisions (or reuses) its own
instance when a publish actually starts.

## How it works

```
Frontend wizard ──Apple relay ws──> Backend pipe (adds API key) ──> Limrun registry ──> Apple
      │                                                  (Developer Portal + App Store Connect)
      ├──secrets──> Backend file store (backend/.secrets/)
      └──publish──> Backend POST /publish ──spawns──> lim xcode build --upload-to-testflight
```

- Apple credentials never touch the example backend during Connect: the browser talks to
  Apple through Limrun's relay (the backend only pipes frames and attaches the Limrun API
  key, which never reaches the browser) and writes the resulting signing material into
  the secret store.
- The secret store is deliberately pluggable. The backend's file store implements the same
  REST shape as Limrun's organization secrets API, and the frontend wraps it in a
  `SigningSecretStore` (`frontend/src/lib/backend.ts`). Swap it for
  `createLimrunSecretStore` from `@limrun/ui/apple` or your own database
  without touching the wizard.
- Publishing runs entirely server-side: the backend materializes the stored certificate,
  App Store profile, and App Store Connect API key into temp files and spawns the CLI with
  `--auto-build-number`, so the build number is incremented against App Store Connect
  automatically before every upload.
- Both the TestFlight and App Store methods run the same upload. An App Store release is
  that upload plus attaching the processed build to a version and submitting it for review
  in App Store Connect.

## Branding

Every artifact created on Apple's side (certificate common names, profile names, the API
key nickname) derives from `PUBLISHER_NAME` in `frontend/src/config.ts`. Rebrand the whole
pipeline by changing that one constant; none of the underlying APIs bake in a default.

## Prerequisites

- A Limrun API key from `Limrun Console` > `Settings` [here](https://console.limrun.com/settings).
- The `lim` CLI installed and on the backend host's PATH:
  ```bash
  npm install -g @limrun/cli
  ```
- An Apple Developer Program account (Admin role, required to create App Store Connect
  API keys).
- An iOS project on the backend host. The auto-incremented build number reaches the binary
  through `expo.ios.buildNumber` in `app.json` for Expo projects (written before prebuild)
  and through `CURRENT_PROJECT_VERSION` for projects on Xcode's standard versioning.

## Quick Start

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
```

1. Make your API key available as environment variable. The backend attaches it to the
   Apple relay connection against `https://registry.limrun.com` (override with
   `LIM_REGISTRY_URL`) and passes it to the `lim` CLI for builds.
   ```bash
   export LIM_API_KEY="your api key"
   ```
1. Start the backend.
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

## Notes

- For Expo projects, a publish searches the project for the Expo `app.json` (monorepo
  layouts like `artifacts/mobile/app.json` included): when `expo.ios.bundleIdentifier`
  is missing, the backend fills it with the bundle ID chosen in the wizard (and says so
  in the build log), because Expo would otherwise prebuild the app under a placeholder
  like `com.anonymous.<slug>`. An existing value is never overwritten; if it differs
  from the chosen bundle ID, the log carries a warning.

- Connect is one-time: on the next visit the wizard sees the stored secrets and jumps
  straight to Publish. "Disconnect and start over" clears the association (stored secrets
  are reused where possible on reconnect, so no duplicate certificates or keys are minted).
- Development and ad-hoc profiles bind registered devices, so those actions are skipped
  with a note when the team has none. They are groundwork for the WebUSB and QR publish
  methods, which are rendered but disabled in this iteration.
- `backend/.secrets/` holds real signing material (private keys, the App Store Connect
  API key). It is gitignored; treat it accordingly.
