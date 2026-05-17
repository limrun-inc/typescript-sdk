# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances in your web applications.

See [examples](../../examples/) to see how it can be used.

## Real Device Installation

`@limrun/ui` also includes a browser-based iPhone installation flow:

- `@limrun/ui/device-install/react` exports the headless `useDeviceInstall` hook for clients that want to render their own UI.
- `@limrun/ui/device-install` exports the guided `DeviceInstallDialog` UI, which walks users through a signed device build, USB access, browser pairing, and installation.

WebUSB requires a Chromium browser and a secure context. Pair records and signing assets, including the `.p12` password, are stored in the browser's IndexedDB.

### Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.
