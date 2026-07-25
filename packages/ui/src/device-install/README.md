# Install to a real iPhone over WebUSB

Install a signed iOS app onto a physical iPhone that's plugged into the user's
own computer — straight from the browser, no Mac and no Xcode on their machine.
The browser talks to the iPhone over WebUSB; Limrun's **registry** runs the
native pairing and install on its side and relays the USB traffic over a
WebSocket.

`@limrun/ui` ships the browser primitives and React hooks; your app owns the UI.
There is no prebuilt wizard, so you decide how much of the flow to expose and
how the steps look in your product.

The flow:

1. **Pair** the iPhone over WebUSB through Limrun's registry (the user taps
   _Trust_ once).
2. **Get signing credentials** — sign in with an Apple ID in the browser and
   persist the certificate + provisioning profile into a `SigningSecretStore`
   (`@limrun/ui/apple`).
3. **Build** a signed `iphoneos` IPA from your backend with `@limrun/api`,
   uploading it to Limrun asset storage.
4. **Install** the asset onto the paired iPhone over the registry's WebUSB
   relay.

Only steps 1, 2, and 4 happen in the browser. The build is a backend concern:
your UI calls your backend, and your backend drives the Xcode sandbox with
`@limrun/api` using the stored signing secrets.

> **Want to see it working first?** A runnable pair-and-install reference with
> scoped-token minting lives in
> [`examples/device-install`](../../../../examples/device-install); a minimal
> single-page version lives in [`src/device-install/demo`](./demo). For the
> Apple sign-in + secret store + backend build flow, see
> [`examples/publish-to-stores`](../../../../examples/publish-to-stores).

## Requirements

- A **Chromium** browser (Chrome or Edge). WebUSB is not available in Safari or
  Firefox.
- A **secure context** — your app must be served over `https://` or `localhost`.
- A physical iPhone connected over USB; the user unlocks it and taps **Trust**
  during pairing.
- An Apple signing identity: a development certificate and a provisioning
  profile that covers the app's bundle ID **and** the target device's UDID.
  See [Signing credentials](#signing-credentials).

## Install

```bash
npm install @limrun/ui
```

The browser side is split across two subpath entry points:

| Import                                 | Provides                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@limrun/ui/device-install` + `/react` | WebUSB device selection, pairing, install relay, pair-record storage (`useDeviceInstallRelay`).                                                                     |
| `@limrun/ui/apple` + `/react`          | Apple ID login (SRP + 2FA), Apple Developer Portal calls, and `SigningSecretStore`-based credential helpers (`useAppleIDLogin`, `ensureAppleCertificateSecret`, …). |

## The registry

Pairing, install, and the Apple relay all run on **Limrun's registry**
(`https://registry.limrun.com`), a shared service that authenticates a Limrun
token. Your org API key works, but it must never reach the browser. Instead,
your backend mints a **scoped token** with `@limrun/api` and hands that to
the browser, which connects to the registry directly:

```ts
// Your backend. The API key stays here.
import Limrun from '@limrun/api';

const limrun = new Limrun({ apiKey: process.env['LIM_API_KEY'] });
const session = await limrun.scopedTokens.create({
  scopes: ['device:*:install', `asset:${assetId}:read`],
  // ttlSeconds: 3600 is the default; maximum is 14400.
});
// Return session.token to the browser.
```

```tsx
// Your frontend. Point the hook straight at the registry.
const install = useDeviceInstallRelay({
  registryApiUrl: 'https://registry.limrun.com',
  token: session.token,
});
```

Scopes have the form `<resource>:<id|*>:<action>` — `device:*:install` opens
the device relay, `asset:<id>:read` (or `asset:*:read`) lets installs read
those assets, and `applerelay:*:connect` opens the Apple relay for the
`@limrun/ui/apple` flow. Scoped tokens are verified offline, expire on
their own (they cannot be revoked, so keep TTLs short), and can only install
from assets — the registry rejects `{ url }` sources for them.
`examples/device-install/backend` is a complete minting backend you can copy.

## Pair the iPhone

`useDeviceInstallRelay` drives the WebUSB side. `requestUSBAccess` opens the
browser's device picker; `pairBrowser` runs the pairing handshake through the
relay and stores the resulting pair record in the browser's IndexedDB, so the
user only taps **Trust** once per device.

```tsx
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';

const install = useDeviceInstallRelay({
  registryApiUrl,
  token,
  organizationId,
  log: (m, d) => console.log(m, d),
});

// 1. Pick the iPhone (shows Chrome's WebUSB chooser).
await install.requestUSBAccess();
// install.device?.hello.serialNumber is the UDID.

// 2. Pair (user unlocks + taps Trust). Stored for next time.
await install.pairBrowser();
// install.hasPairRecord === true
```

| Field / method                             | Use                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `requestUSBAccess()`                       | Open the WebUSB picker and select the iPhone.                                                    |
| `pairBrowser()`                            | Pair through the relay; persists the pair record.                                                |
| `startInstallation(source)`                | Install an IPA onto the paired device; `source` is `{ assetName }`, `{ assetId }`, or `{ url }`. |
| `device`                                   | Selected device; `device.hello.serialNumber` is the UDID.                                        |
| `hasPairRecord` / `canPair` / `canInstall` | Gating flags for your buttons.                                                                   |
| `busyAction`                               | `'usb'`, `'pair'`, or `'install'` while an operation is in flight.                               |
| `error`                                    | Last error message, if any.                                                                      |

Pairing is independent of the build — you can pair before signing or building.
Only `startInstallation()` needs both a stored pair record and an artifact to
install.

## Signing credentials

A real-device install must be signed. The `@limrun/ui/apple` credential helpers
run the Apple ID login in the browser (the password never leaves it — only SRP
proof material does) and persist the resulting material into a
`SigningSecretStore` you provide: Limrun's org secret store
(`createLimrunSecretStore`), the browser's IndexedDB
(`createBrowserSecretStore`), or your own implementation of the interface —
your backend's database, a KMS, anything.

```tsx
import { useAppleIDLogin } from '@limrun/ui/apple/react';
import {
  createAppleProfile,
  ensureAppleCertificateSecret,
  registerAppleDevice,
  saveAppleProfileSecret,
  stringField,
  type SigningSecretStore,
} from '@limrun/ui/apple';

const appleLogin = useAppleIDLogin({ registryApiUrl, token, organizationId });
const session = await appleLogin.startLogin({ accountName, password });
if (session?.requiresTwoFactor) await appleLogin.submitTwoFactorCode(code);
const relay = appleLogin.session!.relay;

// Reuses the stored certificate when it's still on the team, mints one
// otherwise (Apple caps development certs at 2 and never returns private keys).
const certificate = await ensureAppleCertificateSecret({
  relay,
  teamId,
  secretStore, // your SigningSecretStore
  certificateKind: 'development',
});

// Register the paired iPhone and mint a profile covering it, then persist
// the profile bytes as a secret.
await registerAppleDevice({ relay, teamId, deviceUDID, name: 'My iPhone' });
const profile = await createAppleProfile({
  relay,
  teamId,
  profileKind: 'development',
  bundleId,
  appIdId,
  certificateIds: [certificate.certificateId],
  deviceIds: [appleDeviceId],
  name: `MyApp ${Date.now()}`,
});
const profileSecret = await saveAppleProfileSecret({
  relay,
  teamId,
  profileId: stringField(profile, 'provisioningProfileId')!,
  secretStore,
});
```

These are Apple's rules, not Limrun's, and each one is a common dead end:

| Rule                                                     | Consequence if ignored                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A cert is useless without its private key.               | You can only sign with a cert whose key is in your secret store. Apple never returns private keys.                                           |
| Max **2** development certs per team.                    | Creating one per build fails with _"you already have a current Development certificate"_. `ensureAppleCertificateSecret` reuses when it can. |
| A revoked cert still appears in lists.                   | Signing with it builds fine but the device rejects install with `ApplicationVerificationFailed`. Treat revoked certs as unusable.            |
| The team id may live in `providerId`/`publicProviderId`. | Reading only `teamId` leaves the flow stuck after sign-in.                                                                                   |
| Profiles are device-scoped and immutable.                | To authorize a new device you regenerate the profile (see [Adding a device](#add-a-device-to-a-profile)).                                    |

## Build a signed IPA (backend)

Builds run on a Limrun Xcode sandbox, driven from **your backend** with
`@limrun/api`. Read the certificate and profile out of your secret store and
pass them as the signing config; `upload: { assetName }` mints the asset and
uploads the signed IPA to it when the build succeeds.

```ts
import Limrun from '@limrun/api';

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });
const instance = await lim.xcodeInstances.create({ wait: true, reuseIfExists: true });
const xcode = await lim.xcodeInstances.createClient({ instance });

// Sync your project first: await xcode.sync('path/to/project') or `lim xcode sync .`
const { exitCode } = await xcode.xcodebuild(
  { sdk: 'iphoneos' },
  {
    signing: {
      certificateP12Base64: certificateSecret.data.certificateP12Base64,
      certificatePassword: certificateSecret.data.certificatePassword,
      provisioningProfileBase64: profileSecret.data.provisioningProfileBase64,
    },
    upload: { assetName: 'my-app.ipa' },
  },
);
```

Your UI just calls your backend endpoint and waits for it to report success —
no build client or log streaming is needed in the browser.

## Install over WebUSB

Once the artifact is in asset storage and the device is paired, install:

```tsx
await install.startInstallation({ assetName: 'my-app.ipa' });
```

Progress streams through your `log` callback. The relay surfaces the device's
real reason on failure (for example
`Install error: ApplicationVerificationFailed — The identity used to sign the executable is no longer valid.`),
so render the log — it's the fastest way to diagnose a signing/profile mismatch.

## Run the demo

The demo is a standalone Vite page covering pair → install:

```bash
cd packages/ui
npm install
npx vite src/device-install/demo
```

Open the printed `https://localhost` URL in Chrome or Edge, paste a registry URL
and token (a scoped token or, for local experiments, an API key), then pair
and install an asset by name.
[`examples/device-install`](../../../../examples/device-install) is the same
flow with a backend that mints scoped tokens so the API key stays
server-side.

## Add a device to a profile

Provisioning profiles can't be edited in place. To authorize a new iPhone,
**register the UDID, then regenerate the profile** with it included:

1. `registerAppleDevice({ deviceUDID })` — add the UDID to the team.
2. `createAppleProfile({ ..., deviceIds: [...existing, newDeviceId] })` — mint a
   fresh profile (unique `name`).
3. `saveAppleProfileSecret(...)` — download and persist the new bytes.

This needs an Apple Developer session. A profile that's missing the device
can't be amended locally — regenerate it through the Apple flow.

## Storage and security

- **Pair records** live in the browser's IndexedDB. They stay on the device
  unless your app moves them.
- **Signing secrets** (`.p12`, `.mobileprovision`, passwords) live wherever
  your `SigningSecretStore` puts them — Limrun's org secret store, the
  browser, or your own backend.
- The **Apple ID password never reaches Limrun** — only SRP proof material does.
- The registry authenticates a Limrun token — keep your org API key on your
  backend and hand the browser a scoped scoped token
  (`limrun.scopedTokens.create`) instead. Serve the UI over HTTPS in
  production.

## Troubleshooting

| Symptom                                                                                          | Cause and fix                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebUSB is not available`                                                                        | Use Chrome/Edge on HTTPS or `localhost`. Safari/Firefox are unsupported.                                                                                                                                     |
| `Unable to claim interface` / "operation in progress"                                            | Unplug/replug the iPhone, unlock it, close other WebUSB tabs, retry. Make sure you're on a current `@limrun/ui`.                                                                                             |
| First transfer fails with _"endpoint is not part of a claimed and selected alternate interface"_ | Update `@limrun/ui` — recent versions explicitly select the usbmux alternate (incl. alt 0).                                                                                                                  |
| Pairing seems to hang                                                                            | The user must unlock the iPhone and tap **Trust**; the first attempt can fail if the prompt isn't accepted in time. Retry.                                                                                   |
| `no synced folder found; call /sync first`                                                       | Sync your project into the sandbox before building (`xcode.sync(...)` / `lim xcode sync .`).                                                                                                                 |
| Install fails, log shows `ApplicationVerificationFailed`                                         | Signed with a **revoked/invalid cert**, or the **device isn't in the profile**, or the **bundle ID isn't covered**. `zsign` doesn't rewrite the bundle ID — it must match (or be wildcarded by) the profile. |
| `no current certificates matching the provided certificate IDs`                                  | You passed a `certRequestId`, or the cert was revoked. `ensureAppleCertificateSecret` resolves the canonical `certificateId` for you.                                                                        |
| `You already have a current Development certificate…`                                            | Apple's cert cap. Reuse the stored cert (`ensureAppleCertificateSecret` does), or revoke one at developer.apple.com.                                                                                         |
| `Multiple profiles found with the name '…'`                                                      | Give created profiles a unique name.                                                                                                                                                                         |
| Apple flow does nothing after sign-in                                                            | Resolve the team id across `teamId`/`providerId`/`publicProviderId`.                                                                                                                                         |

## Next steps

Provision an Xcode sandbox, sync source, and produce signed IPAs. Drive a simulator for the same app: taps, screenshots, logs, recordings. Build every PR and post a live preview link from a GitHub workflow.
