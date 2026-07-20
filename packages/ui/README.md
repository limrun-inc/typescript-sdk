# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances in your web applications.

See [examples](../../examples/) to see how it can be used.

## Real Device Installation Primitives

`@limrun/ui` includes browser primitives for building your own iPhone
installation UI. The package no longer exports a guided install dialog.

- `@limrun/ui/apple` exports everything Apple credential related: the Apple ID relay and login, Apple Developer Portal calls for teams, certificates, profiles, bundle IDs and devices, App Store Connect calls, CSR/p12 crypto, provisioning profile parsing, and the pluggable signing secret stores.
- `@limrun/ui/apple/react` exports thin React state helpers for Apple ID login.
- `@limrun/ui/device-install` exports WebUSB access, pairing, pair-record storage, and install relay primitives.
- `@limrun/ui/device-install/react` exports focused React state for device access, pairing, and relay installation.

The primitives are intentionally low-level. Your app decides whether to create
or reuse Apple certificates and provisioning profiles, how to present devices
and bundle IDs, and where signing secrets live (`SigningSecretStore`). Builds
are a backend concern: trigger them with `@limrun/api` from your own server.

```ts
import { listAppleTeams, createAppleProfile, ensureAppleCertificateSecret } from '@limrun/ui/apple';
import { requestUSBAccess, pairDevice, startDeviceInstall } from '@limrun/ui/device-install';
```

WebUSB requires a Chromium browser and a secure context. Pair records are stored
in the browser's IndexedDB; signing secrets go wherever your `SigningSecretStore`
implementation puts them.

### Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.
