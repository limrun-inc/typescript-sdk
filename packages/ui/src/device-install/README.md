# Install to a real iPhone over WebUSB

Build a signed iOS app on Limrun and install it onto a physical iPhone that's
plugged into the user's own computer — straight from the browser, no Mac and no
Xcode on their machine. The browser talks to the iPhone over WebUSB; Limrun runs
the native pairing and install on its side and relays the
USB traffic over a WebSocket.

`@limrun/ui` ships the browser primitives and React hooks; your app owns the UI.
There is no prebuilt wizard, so you decide how much of the Apple Developer flow
to expose and how the steps look in your product.

The flow:

1. **Provision** an Xcode build sandbox and get its `apiUrl` + `token`.
2. **Pair** the iPhone over WebUSB (the user taps _Trust_ once).
3. **Get signing assets** — upload a `.p12` + `.mobileprovision`, or sign in with
   an Apple ID and let Limrun fetch them.
4. **Build** a signed `iphoneos` IPA on the sandbox; logs stream back.
5. **Install** the IPA onto the paired iPhone over the WebUSB relay.

> **Want to see it working first?** A complete, runnable reference app — with the
> upload and Apple Developer signing flows, a status stepper, and error handling —
> lives in [`src/device-install/demo`](./demo). Read its
> [`demo.tsx`](./demo/demo.tsx) end to end to see how every hook and helper in this
> guide fits together, or run it locally (see [Run the demo](#run-the-demo)).

## Requirements

- A **Chromium** browser (Chrome or Edge). WebUSB is not available in Safari or
  Firefox.
- A **secure context** — your app must be served over `https://` or `localhost`.
- A physical iPhone connected over USB; the user unlocks it and taps **Trust**
  during pairing.
- An Apple signing identity: a development `.p12` (with its private key) and a
  `.mobileprovision` that covers the app's bundle ID **and** the target device's
  UDID. See [Apple signing](#get-signing-assets).

## Install

```bash
npm install @limrun/ui
```

The feature is split across three subpath entry points so you only pull in what
you use:

| Import                                  | Provides                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@limrun/ui/device-install` + `/react`  | WebUSB device selection, pairing, install relay, pair-record storage (`useDeviceInstallRelay`).     |
| `@limrun/ui/device-build` + `/react`    | Signing-asset import/validation, signed-build trigger, log streaming (`useDeviceBuild`).            |
| `@limrun/ui/app-store-relay` + `/react` | Apple ID login (SRP + 2FA) and Apple Developer Portal calls (`useAppleIDLogin`, `list*`/`create*`). |

## Get a build sandbox

Every call below takes an `apiUrl` and `token` that point at a Limrun Xcode
sandbox. Provision one with the `@limrun/api` SDK or the CLI, then read them off
the instance status — see [Build with remote Xcode](https://docs.limrun.com/docs/ios/build-with-xcode).

```ts
import Limrun from '@limrun/api';

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });
const xcode = await lim.xcodeInstances.create({ wait: true, reuseIfExists: true });

const apiUrl = xcode.status.apiUrl; // HTTP base for the sandbox
const token = xcode.status.token; // per-instance bearer
```

The sandbox must have your project **synced** before a build runs (`lim xcode build .`
or `lim xcode sync .`). A build against an empty sandbox returns
`no synced folder found; call /sync first`.

The `token` is an **instance-scoped** bearer, not your org API key. It's safe to hand to the browser for this one sandbox; it can't touch the rest of your account.

## Pair the iPhone

`useDeviceInstallRelay` drives the WebUSB side. `requestUSBAccess` opens the
browser's device picker; `pairBrowser` runs the pairing handshake through the
relay and stores the resulting pair record in the browser's IndexedDB, so the
user only taps **Trust** once per device.

```tsx
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';

const install = useDeviceInstallRelay({ apiUrl, token, log: (m, d) => console.log(m, d) });

// 1. Pick the iPhone (shows Chrome's WebUSB chooser).
await install.requestUSBAccess();
// install.device?.hello.serialNumber is the UDID.

// 2. Pair (user unlocks + taps Trust). Stored for next time.
await install.pairBrowser();
// install.hasPairRecord === true
```

| Field / method                             | Use                                                                |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `requestUSBAccess()`                       | Open the WebUSB picker and select the iPhone.                      |
| `pairBrowser()`                            | Pair through the relay; persists the pair record.                  |
| `startInstallation()`                      | Install the latest signed build onto the paired device.            |
| `device`                                   | Selected device; `device.hello.serialNumber` is the UDID.          |
| `hasPairRecord` / `canPair` / `canInstall` | Gating flags for your buttons.                                     |
| `busyAction`                               | `'usb'`, `'pair'`, or `'install'` while an operation is in flight. |
| `error`                                    | Last error message, if any.                                        |

Pairing is independent of the build — you can pair before signing or building.
Only `startInstallation()` needs both a stored pair record and a successful
build.

## Get signing assets

A real-device install must be signed. You produce a `StoredSigningAssets` object
(persisted in IndexedDB) one of two ways, then hand it to the build step.

### Option A — upload files (simplest)

Ask the user for a `.p12` (with its private key), its password, and a
`.mobileprovision`. `importSigningAssetsFromFiles` validates the profile against
the bundle ID and device, then stores it.

```tsx
import { importSigningAssetsFromFiles } from '@limrun/ui/device-build';

const assets = await importSigningAssetsFromFiles({
  certificateFile, // File (.p12)
  provisioningProfileFile, // File (.mobileprovision)
  certificatePassword,
  bundleId, // e.g. 'com.example.MyApp'
  deviceUDID: install.device?.hello.serialNumber,
  signingMode: 'development',
});
```

### Option B — sign in with Apple ID

For a guided experience with no files to find, use the App Store Connect relay.
The user's password never leaves the browser: the SRP proof is computed
client-side and the relay only forwards Apple's auth and provisioning requests.

```tsx
import { useAppleIDLogin } from '@limrun/ui/app-store-relay/react';
import {
  registerAppleDevice,
  listAppleCertificates,
  createAppleCertificate,
  downloadAppleCertificate,
  exportAppleCertificateP12,
  generateAppleSigningKeyAndCSR,
  createAppleProfile,
  downloadAppleProfile,
} from '@limrun/ui/app-store-relay';
import {
  getLatestSigningAssetsWithCertificate,
  parseProvisioningProfileBase64,
  putAppleGeneratedSigningAssets,
} from '@limrun/ui/device-build';

const appleLogin = useAppleIDLogin({ limbuildApiUrl: apiUrl, token });
const session = await appleLogin.startLogin({ accountName, password });
if (session?.requiresTwoFactor) await appleLogin.submitTwoFactorCode(code);

// Resolve the team id across all three fields Apple may use.
const teamId = team.teamId ?? String(team.providerId ?? team.publicProviderId ?? '');
const base = { apiUrl, token, appleSessionId: appleLogin.session!.appleSessionId, teamId };

// Register the paired iPhone (no-op if already registered).
await registerAppleDevice({ ...base, deviceUDID, name: 'My iPhone' });

// Reuse a stored cert if its key is in this browser and it's still current;
// otherwise mint a new one.
let certificateId: string | undefined;
let certificateP12Base64: string | undefined;
const stored = await getLatestSigningAssetsWithCertificate(teamId, 'development');
if (stored?.certificateID && stored.certificateP12Base64) {
  const current = await listAppleCertificates({ ...base, certificateKind: 'development' });
  const match = current.find(
    (c) => c.certificateId === stored.certificateID || c.certRequestId === stored.certificateID,
  );
  if (match) {
    certificateId = (match.certificateId as string) ?? stored.certificateID; // canonical id
    certificateP12Base64 = stored.certificateP12Base64;
  }
}
if (!certificateId) {
  const key = await generateAppleSigningKeyAndCSR({ commonName: 'My App' });
  const created = await createAppleCertificate({
    ...base,
    certificateKind: 'development',
    csrPEM: key.csrPEM,
  });
  certificateId = (created?.certificateId as string) ?? (created?.certRequestId as string);
  const cer = await downloadAppleCertificate({ ...base, certificateKind: 'development', certificateId });
  certificateP12Base64 = exportAppleCertificateP12({
    privateKeyPKCS8Base64: key.privateKeyPKCS8Base64,
    certificateBase64: cer.rawBodyBase64!,
    password: certificatePassword,
  });
}

// Create a profile covering the bundle ID + device (unique name avoids
// "multiple profiles with the same name"), download it, and store everything.
const profile = await createAppleProfile({
  ...base,
  profileKind: 'development',
  bundleId,
  appIdId,
  certificateIds: [certificateId],
  deviceIds: [appleDeviceId],
  name: `MyApp ${Date.now()}`,
});
const profileId = (profile?.provisioningProfileId as string) ?? (profile?.profileId as string);
const downloaded = await downloadAppleProfile({ ...base, profileId });

const assets = await putAppleGeneratedSigningAssets({
  bundleID: bundleId,
  deviceUDID,
  teamID: teamId,
  signingMode: 'development',
  certificateID: certificateId,
  certificateP12Base64: certificateP12Base64!,
  certificatePassword,
  provisioningProfileBase64: downloaded.rawBodyBase64!,
  profile: parseProvisioningProfileBase64(downloaded.rawBodyBase64!),
});
```

These are Apple's rules, not Limrun's, and each one is a common dead end:

| Rule                                                     | Consequence if ignored                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A cert is useless without its private key.               | You can only sign with a cert this browser created (and stored) or one imported as `.p12`. Apple never returns private keys.                    |
| Max **2** development certs per team.                    | Creating one per build fails with _"you already have a current Development certificate"_. Reuse, or revoke an old one to free a slot.           |
| Profile creation needs the canonical `certificateId`.    | Passing a `certRequestId` fails with _"no current certificates matching the provided certificate IDs"_. Resolve it via `listAppleCertificates`. |
| A revoked cert still appears in lists.                   | Signing with it builds fine but the device rejects install with `ApplicationVerificationFailed`. Treat revoked certs as unusable.               |
| The team id may live in `providerId`/`publicProviderId`. | Reading only `teamId` leaves the flow stuck after sign-in.                                                                                      |
| Profiles are device-scoped and immutable.                | To authorize a new device you regenerate the profile (see [Adding a device](#add-a-device-to-a-profile)).                                       |

## Build a signed IPA

`useDeviceBuild` triggers a signed `iphoneos` build on the sandbox and streams
the logs. It builds for the device SDK and signs with the assets you pass.

```tsx
import { useDeviceBuild } from '@limrun/ui/device-build/react';

const build = useDeviceBuild({ apiUrl, token, signingAssets: assets });

await build.startBuild({ signingAssets: assets });
// build.status: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
// build.logs: BuildLogLine[]  (render line.data; xcodebuild lines can be long — wrap them)
```

| Field / method                  | Use                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| `startBuild({ signingAssets })` | Kick off the signed device build; returns the exec id.              |
| `status`                        | Build lifecycle state. `succeeded` gates install.                   |
| `logs`                          | Streamed `command` / `stdout` / `stderr` lines.                     |
| `error`                         | Set (and `status` → `failed`) if the build or its log stream fails. |

## Install over WebUSB

Once the build succeeds and the device is paired, install:

```tsx
await install.startInstallation();
```

Progress streams through your `log` callback. The relay surfaces the device's
real reason on failure (for example
`Install error: ApplicationVerificationFailed — The identity used to sign the executable is no longer valid.`),
so render the log — it's the fastest way to diagnose a signing/profile mismatch.

## Full example

A single component covering pair → upload signing → build → install. It assumes
you already have `apiUrl`, `token`, and a `bundleId`.

```tsx
import { useState } from 'react';
import { importSigningAssetsFromFiles, type StoredSigningAssets } from '@limrun/ui/device-build';
import { useDeviceBuild } from '@limrun/ui/device-build/react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';

export function InstallToIPhone({
  apiUrl,
  token,
  bundleId,
}: {
  apiUrl: string;
  token?: string;
  bundleId: string;
}) {
  const [certificateFile, setCertificateFile] = useState<File>();
  const [profileFile, setProfileFile] = useState<File>();
  const [certificatePassword, setCertificatePassword] = useState('');
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets>();
  const [log, setLog] = useState<string[]>([]);
  const append = (m: string, d?: string) => setLog((l) => [d ? `${m}: ${d}` : m, ...l]);

  const install = useDeviceInstallRelay({ apiUrl, token, log: append });
  const build = useDeviceBuild({ apiUrl, token, signingAssets });

  async function prepare() {
    if (!certificateFile || !profileFile) return;
    setSigningAssets(
      await importSigningAssetsFromFiles({
        certificateFile,
        provisioningProfileFile: profileFile,
        certificatePassword,
        bundleId,
        deviceUDID: install.device?.hello.serialNumber,
        signingMode: 'development',
      }),
    );
  }

  return (
    <div>
      {(install.error || build.error) && <pre>{install.error ?? build.error}</pre>}

      <button disabled={!!install.busyAction} onClick={() => void install.requestUSBAccess()}>
        Select iPhone
      </button>
      <button disabled={!install.canPair} onClick={() => void install.pairBrowser()}>
        Pair
      </button>

      <input type="file" accept=".p12" onChange={(e) => setCertificateFile(e.currentTarget.files?.[0])} />
      <input
        type="file"
        accept=".mobileprovision"
        onChange={(e) => setProfileFile(e.currentTarget.files?.[0])}
      />
      <input
        type="password"
        value={certificatePassword}
        onChange={(e) => setCertificatePassword(e.currentTarget.value)}
      />
      <button disabled={!certificateFile || !profileFile} onClick={() => void prepare()}>
        Prepare signing assets
      </button>

      <button disabled={!signingAssets || build.status === 'running'} onClick={() => void build.startBuild()}>
        Start signed build ({build.status})
      </button>

      <button
        disabled={!install.canInstall || build.status !== 'succeeded'}
        onClick={() => void install.startInstallation()}
      >
        Install
      </button>

      <pre>{log.join('\n')}</pre>
    </div>
  );
}
```

A more complete, styled reference (with the Apple Developer flow, a status
stepper, and error handling) lives in
[`src/device-install/demo`](./demo) in this package — see
[`demo.tsx`](./demo/demo.tsx) for the full source.

## Run the demo

The demo is a standalone Vite page you can run against any Xcode build sandbox:

```bash
cd packages/ui
npm install
npx vite src/device-install/demo
```

Open the printed `https://localhost` URL in Chrome or Edge, paste your sandbox's
`apiUrl` and `token`, then walk through pair → sign → build → install. The page
exercises the same hooks and helpers documented above, so it doubles as a
copy-paste reference for your own integration.

## Add a device to a profile

Provisioning profiles can't be edited in place. To authorize a new iPhone,
**register the UDID, then regenerate the profile** with it included:

1. `registerAppleDevice({ deviceUDID })` — add the UDID to the team.
2. `createAppleProfile({ ..., deviceIds: [...existing, newDeviceId] })` — mint a
   fresh profile (unique `name`).
3. `downloadAppleProfile(...)` — fetch the new bytes.

This needs an Apple Developer session. A manually uploaded `.mobileprovision`
that's missing the device can't be amended locally — regenerate it through the
Apple flow.

## Storage and security

- **Pair records** and **signing assets** (`.p12`, `.mobileprovision`, and the
  `.p12` password when given) live in the browser's IndexedDB, written only when
  you call the storage helpers. They stay on the device unless your app moves
  them.
- The **Apple ID password never reaches Limrun** — only SRP proof material does.
- The sandbox `token` is instance-scoped; the Apple session is held in the
  browser. Treat any `.p12` and password your app handles as secrets, and serve
  the UI over HTTPS in production.

## Troubleshooting

| Symptom                                                                                          | Cause and fix                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebUSB is not available`                                                                        | Use Chrome/Edge on HTTPS or `localhost`. Safari/Firefox are unsupported.                                                                                                                                     |
| `Unable to claim interface` / "operation in progress"                                            | Unplug/replug the iPhone, unlock it, close other WebUSB tabs, retry. Make sure you're on a current `@limrun/ui`.                                                                                             |
| First transfer fails with _"endpoint is not part of a claimed and selected alternate interface"_ | Update `@limrun/ui` — recent versions explicitly select the usbmux alternate (incl. alt 0).                                                                                                                  |
| Pairing seems to hang                                                                            | The user must unlock the iPhone and tap **Trust**; the first attempt can fail if the prompt isn't accepted in time. Retry.                                                                                   |
| `no synced folder found; call /sync first`                                                       | Sync your project into the sandbox first (`lim xcode build .` / `lim xcode sync .`).                                                                                                                         |
| Install fails, log shows `ApplicationVerificationFailed`                                         | Signed with a **revoked/invalid cert**, or the **device isn't in the profile**, or the **bundle ID isn't covered**. `zsign` doesn't rewrite the bundle ID — it must match (or be wildcarded by) the profile. |
| `no current certificates matching the provided certificate IDs`                                  | You passed a `certRequestId`, or the cert was revoked. Resolve the canonical `certificateId` via `listAppleCertificates`.                                                                                    |
| `You already have a current Development certificate…`                                            | Apple's cert cap. Reuse a stored cert, upload a `.p12`, or revoke one at developer.apple.com.                                                                                                                |
| `Multiple profiles found with the name '…'`                                                      | Give created profiles a unique name.                                                                                                                                                                         |
| Apple flow does nothing after sign-in                                                            | Resolve the team id across `teamId`/`providerId`/`publicProviderId`.                                                                                                                                         |

## Next steps

Provision an Xcode sandbox, sync source, and produce signed IPAs. Drive a simulator for the same app: taps, screenshots, logs, recordings. Build every PR and post a live preview link from a GitHub workflow.
