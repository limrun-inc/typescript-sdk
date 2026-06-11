# Device Install (WebUSB) Integration

This example shows how to install an Apple-signed build onto a **physical iPhone**
straight from the browser, using a Limrun Xcode build sandbox and the WebUSB relay
in `@limrun/ui`.

It has two components:

- `backend/`: Provisions an Xcode build sandbox with your Limrun API key and hands
  the per-instance `apiUrl` + `token` to the frontend.
- `frontend/`: Pairs the iPhone over WebUSB, prepares signing assets (via Apple
  ID sign-in **or** uploaded files), builds a signed IPA on the sandbox, and
  installs it onto the device — with the `useDeviceInstallRelay`,
  `useDeviceBuild`, and `useAppleIDLogin` hooks.

The full flow: **provision sandbox → pair iPhone → sign → build → install**.

## Requirements

- A **Chromium** browser (Chrome or Edge). WebUSB is not available in Safari or
  Firefox. `http://localhost` counts as a secure context, so the Vite dev server
  works out of the box.
- A physical iPhone connected over USB. The user unlocks it and taps **Trust**
  once during pairing.
- An Apple signing identity, obtained one of two ways:
  - **Sign in with your Apple ID** and let Limrun fetch/create the certificate
    and provisioning profile for you (the default tab in the Signing step). Your
    Apple password never leaves the browser — only SRP proof material is sent.
  - **Upload files** — a development `.p12` (with its private key), its password,
    and a `.mobileprovision` that covers the app's bundle ID **and** the target
    device's UDID.

## Quick Start

Clone this repo and enter this example folder:

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
```

1. Get an API Key from `Limrun Console` > `Settings` page [here](https://console.limrun.com/settings).
1. Make it available as an environment variable.
   ```bash
   export LIM_API_KEY="your api key"
   ```
1. Start the backend.
   ```bash
   yarn --cwd examples/device-install/backend install
   yarn --cwd examples/device-install/backend run dev
   ```
1. In another terminal session, start the frontend.
   ```bash
   yarn --cwd examples/device-install/frontend install
   yarn --cwd examples/device-install/frontend run dev
   ```
1. Go to `localhost:5173`, click **Create Xcode sandbox**, then walk through
   pair → sign → build → install.

## Sync your project before building

A build runs against whatever source is **synced** into the sandbox. After the
backend provisions one, sync your Xcode/Expo project into it from the CLI. Pass
`--id` with the sandbox id shown in the app (the **1. Build sandbox** step) so
the CLI targets that exact instance instead of your most recent one:

```bash
lim xcode sync . --id <sandbox-id>
# or build directly: lim xcode build . --id <sandbox-id>
```

A build against an empty sandbox returns `no synced folder found; call /sync first`.
See [Build with remote Xcode](https://docs.limrun.com/docs/ios/build-with-xcode).

## How it works

- The backend calls `limrun.xcodeInstances.create({ wait: true, reuseIfExists: true })`
  and returns `status.apiUrl` + `status.token`. The `token` is **instance-scoped**
  — safe to hand to the browser for this one sandbox, and it can't touch the rest
  of your account.
- `useDeviceInstallRelay({ apiUrl, token })` drives WebUSB: `requestUSBAccess()`
  opens Chrome's device picker, `pairBrowser()` runs the pairing handshake and
  stores the pair record in IndexedDB (so the user only taps Trust once), and
  `startInstallation()` streams the signed IPA onto the device.
- Signing assets come from one of two tabs in the frontend:
  - **Apple ID** — `useAppleIDLogin` runs the SRP + 2FA login, then the
    `@limrun/ui/app-store-relay` helpers (`listAppleTeams`, `createAppleCertificate`,
    `createAppleProfile`, …) fetch or mint a certificate and provisioning profile,
    which `putAppleGeneratedSigningAssets` stores as `StoredSigningAssets`.
  - **Upload files** — `importSigningAssetsFromFiles(...)` turns the uploaded
    `.p12` + `.mobileprovision` into a `StoredSigningAssets` object and validates
    the profile against the bundle ID and device UDID.
- `useDeviceBuild({ apiUrl, token, signingAssets })` triggers the signed build and
  streams logs back; once `status === 'succeeded'` you can install.

For the complete API reference (including the Apple ID signing path and
troubleshooting), see the
[device-install feature README](../../packages/ui/src/device-install/README.md).
