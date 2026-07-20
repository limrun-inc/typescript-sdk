# Device Install (WebUSB) Integration

This example shows how to install a signed IPA onto a **physical iPhone**
straight from the browser, using the WebUSB relay in `@limrun/ui` and Limrun's
registry.

It has two components:

- `backend/`: A thin WebSocket proxy. It pipes the registry relay endpoints to
  Limrun's registry with your API key attached server-side, so the key never
  reaches the browser.
- `frontend/`: Pairs the iPhone over WebUSB and installs a signed IPA onto it
  with the `useDeviceInstallRelay` hook, pointing `registryApiUrl` at the
  backend.

There is deliberately no build step: signed IPAs are produced on your backend
with `@limrun/api` (`xcodebuild({ sdk: 'iphoneos' }, { signing, upload: { assetName } })`)
and uploaded to Limrun asset storage, then installed here by asset name. Any
HTTPS URL to a signed IPA works too. For the full Apple signing flow (Apple ID
login, certificate + profile secrets), see
[`examples/publish-to-stores`](../publish-to-stores).

## Requirements

- A **Chromium** browser (Chrome or Edge). WebUSB is not available in Safari or
  Firefox. `http://localhost` counts as a secure context, so the Vite dev server
  works out of the box.
- A physical iPhone connected over USB. The user unlocks it and taps **Trust**
  once during pairing.
- A signed IPA to install — an asset in your organization's storage, or an
  HTTPS URL. It must be signed with a development profile that includes the
  target device's UDID.

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
1. Go to `localhost:5173`, pair your iPhone, then install an asset by name (or
   any HTTPS IPA URL).

## How it works

- The backend proxies `/ios/device/ws` (and `/ios/appstoreconnect/ws`, should
  you add an Apple flow) to Limrun's registry (`LIM_REGISTRY_ENDPOINT`, default
  `https://registry.limrun.com`), attaching the API key server-side — see
  `backend/relay-proxy.ts`. The frontend points `registryApiUrl` at the backend.
- `useDeviceInstallRelay({ registryApiUrl })` drives WebUSB: `requestUSBAccess()`
  opens Chrome's device picker, `pairBrowser()` runs the pairing handshake and
  stores the pair record in IndexedDB (so the user only taps Trust once), and
  `startInstallation({ assetName })` (or `{ downloadUrl }`) has the registry
  download the signed IPA and stream it onto the device.
- To produce the artifact, your backend builds with `@limrun/api` on an Xcode
  sandbox and uploads the signed IPA to an org asset; the signing material
  comes out of a `SigningSecretStore` filled by the `@limrun/ui/apple`
  credential helpers.

For the complete API reference (including signing and troubleshooting), see the
[device-install feature README](../../packages/ui/src/device-install/README.md).
