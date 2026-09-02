# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances
in web applications. It exports `RemoteControl` plus accessibility snapshot
types and helpers for building inspect, search, and agent interfaces.

See [examples](../../examples/) to see how it can be used.

## 3D device stage

`RemoteControl` renders the device as an interactive 3D object by default:

- Move your cursor around and the device subtly turns to face it, catching
  the light from a new angle.
- Grab the device — its corner bezels or the space around it — and drag to
  rotate it in 3D. Give it a flick and it spins before settling back to face
  you.

Screen input stays pixel-accurate while the device is tilted: pointer
positions are unprojected back onto the device surface before touch
injection. Precision modes (Alt-pinch, the inspect overlay) flatten the
device while active, and the effect is disabled automatically for users who
prefer reduced motion. Pass `interactive3d={false}` to opt out entirely.

Related browser workflow packages are published separately:

- `@limrun/apple-auth` handles Apple ID login, signing credentials, and App
  Store Connect.
- `@limrun/device-install` handles WebUSB pairing and real-device installation.
- `@limrun/play-auth` handles Google login and Google Play publishing.

## Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.
