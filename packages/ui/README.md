# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances
in web applications. It exports `RemoteControl` plus accessibility snapshot
types and helpers for building inspect, search, and agent interfaces.

See [examples](../../examples/) to see how it can be used.

## Simulated cameras

`RemoteControl` responds automatically when an app in the instance opens,
closes, or switches a virtual camera. Camera facing is a preference: the
component requests the browser's `user` or `environment` camera with an
`ideal` constraint and falls back to an available input. Repeated requests for
the same facing reuse the live track. Facing changes restart capture so mobile
browsers can release one camera before opening the other.

`cameraResolutionCap` controls browser capture independently: named caps use
standard landscape ideals such as 1280×720 for `720p`. `cameraAspect` controls
only the simulated camera's host-side crop/output shape, so `9:16` does not
rotate browser capture constraints. Set `cameraAspect="auto"` or remove the
prop to clear an explicit override and derive output sizing from incoming
frames. `onCameraDemandChange` receives fresh `MediaStreamTrack.getSettings()`
status metadata after track and resolution changes.

Camera API types (`CameraRequest`, `CameraResult`, `CameraFacingMode`,
`CameraAspect`, `CameraResolutionCap`, `CameraCaptureInfo`, and
`CameraStreamStats`) are exported from `@limrun/ui`.

Related browser workflow packages are published separately:

- `@limrun/apple-auth` handles Apple ID login, signing credentials, and App
  Store Connect.
- `@limrun/device-install` handles WebUSB pairing and real-device installation.
- `@limrun/play-auth` handles Google login and Google Play publishing.

## Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.
