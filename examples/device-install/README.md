# Device Install (WebUSB) Integration

This example shows how to install a signed IPA onto a **physical iPhone**
straight from the browser, using the WebUSB relay in `@limrun/ui` and Limrun's
registry.

It has two components:

- `backend/`: Mints short-lived **scoped registry tokens** with
  `limrun.scopedTokens.create` from `@limrun/api`. Your API key stays
  server-side; the browser only ever holds a token that can open the device
  relay and read the granted assets, and it expires on its own.
- `frontend/`: Fetches a session token from the backend, then pairs the iPhone
  over WebUSB and installs a signed IPA onto it with the
  `useDeviceInstallRelay` hook — talking to Limrun's registry **directly**, no
  proxying.

There is deliberately no build step: signed IPAs are produced on your backend
with `@limrun/api` (`xcodebuild({ sdk: 'iphoneos' }, { signing, upload: { assetName } })`)
and uploaded to Limrun asset storage, then installed here by asset name. For
the full Apple signing flow (Apple ID login, certificate + profile secrets),
see [`examples/publish-to-stores`](../publish-to-stores).

## Requirements

- A **Chromium** browser (Chrome or Edge). WebUSB is not available in Safari or
  Firefox. `http://localhost` counts as a secure context, so the Vite dev server
  works out of the box.
- A physical iPhone connected over USB. The user unlocks it and taps **Trust**
  once during pairing.
- A signed IPA uploaded as an asset in your organization's storage. It must be
  signed with a development profile that includes the target device's UDID.

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
1. Go to `localhost:5173`, pair your iPhone, then install an asset by name.

## How it works

- The backend exposes `POST /session`, which calls
  `limrun.scopedTokens.create({ scopes })` with `device:*:install` plus an
  asset read scope. Scopes have the form `<resource>:<id|*>:<action>`; pass a
  specific asset id (`asset:asset_…:read`) to confine the token to one
  artifact, as the route does when you send it an `assetName`. Tokens default
  to a 1 hour TTL and cannot be revoked, so keep them short-lived.
- The frontend fetches a session on load and hands `registryUrl` + `token` to
  `useDeviceInstallRelay`. The browser then connects to Limrun's registry
  (`LIM_REGISTRY_ENDPOINT`, default `https://registry.limrun.com`) directly:
  `requestUSBAccess()` opens Chrome's device picker, `pairBrowser()` runs the
  pairing handshake and stores the pair record in IndexedDB (so the user only
  taps Trust once), and `startInstallation({ assetName })` has the registry
  download the signed IPA and stream it onto the device.
- Scoped tokens can only install from assets — the registry rejects
  arbitrary download URLs for them — so the token cannot be abused as a
  download proxy even if it leaks before expiry.
- To produce the artifact, your backend builds with `@limrun/api` on an Xcode
  sandbox and uploads the signed IPA to an org asset; the signing material
  comes out of a `SigningSecretStore` filled by the `@limrun/ui/apple`
  credential helpers.

For the complete API reference (including signing and troubleshooting), see the
[device-install feature README](../../packages/ui/src/device-install/README.md).
