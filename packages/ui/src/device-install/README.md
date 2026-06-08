# Real Device Install With WebUSB

This guide explains how to add Limrun's real-device iPhone install flow to your
web app.

The feature lets a user connect an iPhone to their computer, build a signed
`iphoneos` app in Limrun, and install it onto the device directly from the
browser. The browser talks to the iPhone with WebUSB; Limrun handles the native
iOS install protocol on the server side.

## What You Build

Your application owns the UI. The `@limrun/ui` package provides low-level
browser primitives and React hooks for:

- selecting an iPhone over WebUSB
- pairing the browser with the iPhone
- storing the pair record locally in the browser
- importing or creating Apple signing assets
- triggering a signed Limrun device build
- installing the signed build onto the paired iPhone

There is intentionally no prebuilt wizard. This lets you fit the flow into your
own product and choose how much Apple Developer Portal automation to expose.

## Browser And Device Requirements

- Chromium-based browser with WebUSB support, such as Chrome or Edge.
- Secure context: your app must run on `https://` or `localhost`.
- Physical iPhone connected over USB.
- User must unlock the iPhone and tap **Trust** during pairing.
- iOS provisioning profile must include the iPhone UDID.

Safari and Firefox do not support WebUSB.

## Apple Signing Requirements

An app installed on a real iPhone must be signed with:

- a `.p12` certificate that includes the private key
- the `.p12` password, if one was set
- a `.mobileprovision` profile that covers the app bundle ID and the target
  device UDID

You have two implementation options:

1. **Upload signing files**: ask the user for a `.p12` and `.mobileprovision`.
   This is the simplest and most reliable flow.
2. **Apple Developer Portal flow**: let the user sign in with Apple ID, register
   devices, create or reuse a certificate, and create/download a provisioning
   profile.

Important Apple limitation: an existing Apple certificate cannot be used unless
the browser also has the private key for it. Apple never returns private keys.
After your app creates a certificate in this browser, `@limrun/ui` stores the
generated `.p12` in IndexedDB so it can be reused on later builds.

## High-Level Flow

1. Your backend or app starts/chooses a Limrun Xcode instance.
2. Your app receives:
   - `limbuildApiUrl`: base URL for that instance's limbuild API
   - `token`: optional instance token, when required
3. User selects the iPhone with WebUSB.
4. User pairs the iPhone. The pair record is stored in browser IndexedDB.
5. User provides signing assets, either by upload or Apple Developer Portal.
6. Your app starts a signed `iphoneos` build on limbuild.
7. After the build succeeds, your app starts the WebUSB install relay.

Pairing can happen before the build. Installation requires both a successful
signed build and a stored pair record.

## Install The Package

```bash
npm install @limrun/ui
```

The package exposes subpath entry points:

```ts
import { importSigningAssetsFromFiles } from '@limrun/ui/device-build';
import { useDeviceBuild } from '@limrun/ui/device-build/react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';
```

## Minimal React Example: Upload Signing Files

This example shows the most direct integration. It assumes your app already has
`limbuildApiUrl` and `token` for a Limrun Xcode instance.

```tsx
import { useState } from 'react';
import { importSigningAssetsFromFiles, type StoredSigningAssets } from '@limrun/ui/device-build';
import { useDeviceBuild } from '@limrun/ui/device-build/react';
import { useDeviceInstallRelay } from '@limrun/ui/device-install/react';

export function RealDeviceInstall({
  limbuildApiUrl,
  token,
  bundleId,
}: {
  limbuildApiUrl: string;
  token?: string;
  bundleId: string;
}) {
  const [certificateFile, setCertificateFile] = useState<File>();
  const [profileFile, setProfileFile] = useState<File>();
  const [certificatePassword, setCertificatePassword] = useState('');
  const [signingAssets, setSigningAssets] = useState<StoredSigningAssets>();
  const [messages, setMessages] = useState<string[]>([]);

  const log = (message: string, detail?: string) => {
    setMessages((current) => [detail ? `${message}: ${detail}` : message, ...current]);
  };

  const install = useDeviceInstallRelay({
    apiUrl: limbuildApiUrl,
    token,
    log,
  });

  const build = useDeviceBuild({
    apiUrl: limbuildApiUrl,
    token,
    signingAssets,
  });

  async function prepareSigningAssets() {
    if (!certificateFile || !profileFile) return;

    const assets = await importSigningAssetsFromFiles({
      certificateFile,
      provisioningProfileFile: profileFile,
      certificatePassword,
      bundleId,
      deviceUDID: install.device?.hello.serialNumber,
      signingMode: 'development',
    });

    setSigningAssets(assets);
    log('Signing assets ready', assets.bundleID);
  }

  async function startBuild() {
    const execId = await build.startBuild({ signingAssets });
    if (execId) log('Build started', execId);
  }

  return (
    <div>
      <h2>Install to iPhone</h2>

      {(install.error || build.error) && <pre>{install.error ?? build.error}</pre>}

      <section>
        <h3>1. Pair iPhone</h3>
        <button type="button" disabled={!!install.busyAction} onClick={() => void install.requestUSBAccess()}>
          Select iPhone
        </button>
        <button type="button" disabled={!install.canPair} onClick={() => void install.pairBrowser()}>
          Pair
        </button>
        <p>Selected device: {install.device?.hello.serialNumber ?? 'none'}</p>
        <p>Pair record: {install.hasPairRecord ? 'stored' : 'not found'}</p>
      </section>

      <section>
        <h3>2. Signing files</h3>
        <label>
          .p12 certificate
          <input
            type="file"
            accept=".p12,application/x-pkcs12"
            onChange={(event) => setCertificateFile(event.currentTarget.files?.[0])}
          />
        </label>
        <label>
          .mobileprovision profile
          <input
            type="file"
            accept=".mobileprovision"
            onChange={(event) => setProfileFile(event.currentTarget.files?.[0])}
          />
        </label>
        <label>
          Certificate password
          <input
            type="password"
            value={certificatePassword}
            onChange={(event) => setCertificatePassword(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={!certificateFile || !profileFile}
          onClick={() => void prepareSigningAssets()}
        >
          Prepare signing assets
        </button>
      </section>

      <section>
        <h3>3. Build</h3>
        <button
          type="button"
          disabled={!signingAssets || build.status === 'running'}
          onClick={() => void startBuild()}
        >
          Start signed build
        </button>
        <p>Build status: {build.status}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflow: 'auto' }}>
          {build.logs
            .slice(-40)
            .map((line) => line.data)
            .join('\\n')}
        </pre>
      </section>

      <section>
        <h3>4. Install</h3>
        <button
          type="button"
          disabled={!install.canInstall || build.status !== 'succeeded'}
          onClick={() => void install.startInstallation()}
        >
          Install
        </button>
      </section>

      <section>
        <h3>Activity</h3>
        <pre>{messages.join('\\n')}</pre>
      </section>
    </div>
  );
}
```

## Apple Developer Portal Flow

The upload flow is easiest to ship. If you want a fully guided experience, use
the App Store Connect relay APIs from `@limrun/ui/app-store-relay`.

Typical sequence:

1. Start Apple ID login with `useAppleIDLogin`.
2. List teams with `listAppleTeams`.
3. List or create a bundle ID with `listAppleBundleIDs` and
   `createAppleBundleID`.
4. Select the paired iPhone's UDID and register it if needed with
   `registerAppleDevice`.
5. Create or reuse a certificate:
   - create a key + CSR with `generateAppleSigningKeyAndCSR`
   - submit with `createAppleCertificate`
   - download with `downloadAppleCertificate`
   - export `.p12` with `exportAppleCertificateP12`
6. Create and download a development profile with `createAppleProfile` and
   `downloadAppleProfile`.
7. Parse and store the assets with `parseProvisioningProfileBase64` and
   `putAppleGeneratedSigningAssets`.

The user's Apple ID password is not sent to Limrun. SRP proof generation happens
in the browser; the relay forwards Apple auth/provisioning requests and carries
Apple session state.

### Certificate Reuse

Apple limits development certificates per team. Do not create a new certificate
for every build.

Recommended behavior:

- Reuse a locally stored `.p12` when available.
- Before reuse, call `listAppleCertificates` and verify the stored certificate ID
  still exists on the Apple team.
- Only create a new certificate when none exists locally or the stored one has
  been revoked.

`@limrun/ui` stores signing assets in browser IndexedDB when you call the storage
helpers. Customers who use multiple browsers or machines may need to upload or
create signing assets once per browser.

## Limrun Backend Requirements

Your Limrun instance must have a synced iOS project before `startSignedDeviceBuild`
can succeed. If no project has been synced, limbuild returns:

```text
no synced folder found; call /sync first
```

For a customer integration, your application should either:

- launch or select an existing Limrun Xcode instance that already has the
  project synced, or
- sync the project before showing the device-install flow.

The app bundle identifier produced by the Xcode build must be covered by the
provisioning profile:

- exact explicit App ID, such as `com.example.MyApp`
- wildcard profile, such as `com.example.*` or `*`

`zsign` signs the built app; it does not rewrite the app's bundle identifier.

## Pair Records And Signing Asset Storage

The browser stores two kinds of data in IndexedDB:

- pair records, so the user does not need to trust/pair every time
- signing assets, including `.p12`, `.mobileprovision`, and `.p12` password when
  provided

This data stays in the user's browser unless your application exports or uploads
it elsewhere.

## Error Handling Checklist

### WebUSB is not available

Use Chrome or Edge on HTTPS or localhost. Safari and Firefox are unsupported.

### Unable to claim interface

Ask the user to:

- unplug and replug the iPhone
- close other tabs using WebUSB
- unlock the phone
- retry selection

### Endpoint is not part of a selected alternate interface

Use a current version of `@limrun/ui`. The WebUSB implementation explicitly
selects the usbmux alternate interface, including alternate 0.

### Pairing asks user to trust

The user must unlock the iPhone and tap **Trust**. The first pairing attempt may
fail if the prompt was not accepted in time; retry pairing after trust is
accepted.

### Install fails after upload

Most common causes:

- provisioning profile does not include the iPhone UDID
- profile does not cover the app bundle identifier
- certificate/profile team mismatch
- app was built with a bundle ID different from the selected profile

Recreate or upload a profile that includes the selected device and covers the
app's bundle ID.

## Security Notes

- Apple ID password stays in the browser. The relay receives SRP proof material,
  not the password.
- Pair records and signing assets are stored in browser IndexedDB.
- If your application stores signing assets outside the browser, treat `.p12`
  files and passwords as secrets.
- Run the UI on HTTPS in production.

## Production UX Recommendations

- Let users select and pair the iPhone before starting a build.
- Display the selected device UDID and whether a pair record was found.
- Validate that the provisioning profile includes the selected UDID before
  starting the build.
- Reuse stored certificates instead of creating a new Apple certificate for each
  build.
- Wrap build logs in the UI; `xcodebuild` can emit very long lines.
- Keep install logs visible; they are critical for debugging profile/device
  mismatches.
