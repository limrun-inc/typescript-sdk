# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances in your web applications.

See [examples](../../examples/) to see how it can be used.

## Real Device Installation Primitives

`@limrun/ui` includes browser primitives for building your own iPhone
installation UI. The package no longer exports a guided install dialog.

- `@limrun/ui/app-store-relay` exports framework-agnostic Apple ID relay and Apple Developer Portal calls for teams, certificates, profiles, bundle IDs, and devices.
- `@limrun/ui/app-store-relay/react` exports thin React state helpers for Apple ID login.
- `@limrun/ui/device-build` exports signing asset helpers, signed build triggering, build log watching, and OTA install metadata.
- `@limrun/ui/device-build/react` exports build state helpers.
- `@limrun/ui/device-install` exports WebUSB access, pairing, pair-record storage, and install relay primitives.
- `@limrun/ui/device-install/react` exports focused React state for device access, pairing, and relay installation.

The primitives are intentionally low-level. Your app decides whether to create
or reuse Apple certificates and provisioning profiles, how to present devices
and bundle IDs, and when to persist signing assets.

```ts
import { listAppleTeams, createAppleProfile } from '@limrun/ui/app-store-relay';
import { startSignedDeviceBuild } from '@limrun/ui/device-build';
import { requestUSBAccess, pairDevice, startDeviceInstall } from '@limrun/ui/device-install';
```

WebUSB requires a Chromium browser and a secure context. Pair records and signing
assets, including the `.p12` password when provided, are stored in the browser's
IndexedDB only when you call the storage helpers.

### Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.
