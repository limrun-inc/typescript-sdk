# Install an APK on a real Android phone

Install an Android app from the browser onto a physical phone — either by
showing a **QR code** the phone scans to download the APK, or over a **USB
cable** with WebUSB (the browser speaks the ADB protocol directly, no adb
binary needed on the user's machine).

`@limrun/android-install` ships the primitives and a React hook; your app owns
the UI. It is standalone — React is an optional peer dependency needed only by
the `/react` entry point.

## Install

```bash
npm install @limrun/android-install
```

| Import                            | Provides                                                             |
| --------------------------------- | -------------------------------------------------------------------- |
| `@limrun/android-install`         | `installApk`, `requestAndroidDevice`, `apkQrCodeDataUrl`, helpers.   |
| `@limrun/android-install/react`   | `useAndroidApkInstall` hook wrapping the USB flow with React state.  |

## Get a download URL

Both flows start from an APK the phone or browser can download. With the
Limrun assets API, request a signed download URL:

```ts
import Limrun from '@limrun/api';

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });
const [asset] = await lim.assets.list({
  nameFilter: 'builds/app-release.apk',
  includeDownloadUrl: true,
  limit: 1,
});
const downloadUrl = asset.signedDownloadUrl!; // valid for ~15 minutes
```

Any URL the phone (QR flow) or the page (USB flow, subject to CORS) can fetch
works the same way.

## QR code flow

Render the URL as a QR code; the user scans it with the phone's camera,
downloads the APK, and confirms Android's "install unknown apps" prompt.

```tsx
import { apkQrCodeDataUrl } from '@limrun/android-install';

const qr = await apkQrCodeDataUrl(downloadUrl); // PNG data URL
// <img src={qr} alt="Scan to install" />
```

Signed URLs expire (about 15 minutes for Limrun assets) — regenerate the URL
and the QR code if the download fails.

## USB cable flow

Requirements:

- A **Chromium** browser (Chrome or Edge) on a **secure context** (`https://`
  or `localhost`). WebUSB is not available in Safari or Firefox.
- The phone has **Developer options → USB debugging** enabled and is connected
  with a cable.
- No other program is claiming the ADB interface on this computer (close
  Android Studio, run `adb kill-server`).

### With the React hook

```tsx
import { useAndroidApkInstall } from '@limrun/android-install/react';

function InstallButton({ downloadUrl }: { downloadUrl: string }) {
  const android = useAndroidApkInstall({ log: (m, d) => console.log(m, d) });

  if (!android.supported) {
    return <p>USB install needs Chrome or Edge over HTTPS.</p>;
  }
  return (
    <>
      <button disabled={android.busy} onClick={() => void android.requestDevice()}>
        {android.device ? `${android.device.name} (${android.device.serial})` : 'Select device'}
      </button>
      <button
        disabled={!android.device || android.busy}
        onClick={() => void android.install({ downloadUrl })}
      >
        {android.status === 'connecting'
          ? 'Connecting…'
          : android.status === 'authorizing'
            ? 'Approve on the phone…'
            : android.status === 'installing'
              ? 'Installing…'
              : 'Install'}
      </button>
      {android.progress && android.progress.totalBytes > 0 && (
        <progress value={android.progress.receivedBytes} max={android.progress.totalBytes} />
      )}
      {android.error && <pre>{android.error}</pre>}
      {android.status === 'done' && <p>Installed. Check the phone's app drawer.</p>}
    </>
  );
}
```

| Field / method    | Use                                                                       |
| ----------------- | ------------------------------------------------------------------------- |
| `supported`       | False when WebUSB is unavailable; fall back to the QR flow.               |
| `requestDevice()` | Open the WebUSB picker (must run in a click handler).                     |
| `install(source)` | Stream the APK to the device. Source: `{downloadUrl}`, `{file}`, or `{stream, size}`. |
| `status`          | `idle`, `connecting`, `authorizing`, `installing`, `done`, or `error`.    |
| `progress`        | `{ receivedBytes, totalBytes }` while installing.                         |
| `error`           | Friendly message for the last failure.                                    |

### Without React

```ts
import { installApk, requestAndroidDevice } from '@limrun/android-install';

const device = await requestAndroidDevice(); // undefined if the user cancels
if (device) {
  await installApk({
    device,
    source: { downloadUrl },
    log: (message, detail) => console.log(message, detail),
    onProgress: ({ receivedBytes, totalBytes }) => console.log(receivedBytes, totalBytes),
  });
}
```

## Authorization

The first install from a browser triggers Android's **"Allow USB debugging?"**
prompt on the phone. The ADB key pair is generated with the Web Crypto API and
persisted in the browser's IndexedDB, so ticking "Always allow from this
computer" makes later installs silent. The key appears on the phone as
"Limrun" (override with `credentialStoreName`).

## Troubleshooting

| Symptom                                        | Cause and fix                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `WebUSB is not available`                      | Use Chrome/Edge on HTTPS or `localhost`. Offer the QR flow as fallback.                            |
| Device missing from the picker                 | Enable USB debugging on the phone; use a data (not charge-only) cable.                             |
| "The device is used by another program"        | A host `adb` server holds the interface. Run `adb kill-server`, replug, retry.                     |
| Stuck on "authorizing"                         | Unlock the phone and accept the USB debugging prompt.                                              |
| Download fails with 403                        | The signed URL expired — request a fresh one.                                                      |
| `INSTALL_FAILED_*`                             | The device rejected the APK (downgrade, signature mismatch, ABI). The message includes the reason. |
