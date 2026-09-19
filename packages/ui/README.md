# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances
in web applications. It exports `RemoteControl` plus accessibility snapshot
types and helpers for building inspect, search, and agent interfaces.

See [examples](../../examples/) to see how it can be used.

## Frameless embeds

`@limrun/ui` bundles Limrun's device frames and boot logos as inline images, about
600 KB. Embeds that render the bare screen can import `@limrun/ui/lite` instead: the same
`RemoteControl` API without any artwork, so `showFrame` has nothing to draw and the boot
logo is omitted. Pass your own images through the `assets` prop if you want frames back.

`onConnectionStateChange` reports `connecting`, `connected`, `reconnecting`, `failed`, and
`terminated` so a host can show status text without tracking the retry logic.

## Simulated cameras

`RemoteControl` responds automatically when an app in the instance opens,
closes, or switches a virtual camera. Camera facing is a preference: the
component requests the browser's `user` or `environment` camera with an
`ideal` constraint and falls back to an available input. Repeated requests for
the same facing reuse the live track. Facing changes restart capture so mobile
browsers can release one camera before opening the other.

WebRTC and the browser choose the capture resolution. The simulated camera's
host output follows the decoded frame dimensions, including width/height swaps
when captured video rotates. `onCameraDemandChange` receives fresh
`MediaStreamTrack.getSettings()` status metadata after track changes.

Camera API types (`CameraRequest`, `CameraResult`, `CameraFacingMode`,
`CameraCaptureInfo`, and `CameraStreamStats`) are exported from `@limrun/ui`.

Related browser workflow packages are published separately:

- `@limrun/apple-auth` handles Apple ID login, signing credentials, and App
  Store Connect.
- `@limrun/device-install` handles WebUSB pairing and real-device installation.
- `@limrun/play-auth` handles Google login and Google Play publishing.

## Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.

## iPhone Duo

`RemoteControl` discovers native Duo support during connection and loads a 3D
frame with separate cover and inner display streams. No model prop is required.
Use the hinge slider for any angle from 0° closed to 180° flat. Touch and drag
on the visible display interact with iOS. Position starts locked to prevent accidental
rotation. Unlock it to drag the frame or background (or Alt-drag the screen) to move the
camera. Rotate device changes the native orientation. Laptop view sets the
hinge and orientation; it does not enable Apple's separate Table Mode.

Click the frame's Sleep/Wake, Volume Up, or Volume Down buttons to send native
hardware input. Press and hold is supported. These buttons remain active while
the position is locked. Hovering raises the physical button slightly and shows its
name. Buttons remain reachable from the front, and hover does not change the camera
framing.

The renderer requires WebGL. Duo currently supports single-finger gestures;
accessibility inspection and the existing recording API do not follow the
inner display. Use `screenshotDisplay` and `tapDisplay` from the TypeScript
iOS client for explicit display automation.

### Optional Duo appearance

`duoModelUrl` replaces the rigid body with a host-supplied GLB. The host provides
and licenses the asset; no third-party model is bundled with this package.
Live simulator screens, hinge control and input remain active. A failed load keeps
the built-in frame available and reports the error.

The prepared model must contain `folding-half` and `stationary-half` groups with
flat mesh children measured in centimeters. Inner display surfaces lie in the
XY plane, centered at the hinge with positive Z facing the inner display.
Material names `inner-screen` and `cover-screen` identify surfaces replaced by live
video. Hardware meshes under `stationary-half` must carry `extras.button` with
`side`, `volumeUp`, or `volumeDown`. All three are required. This is a prepared Duo
appearance contract, not a general-purpose GLB viewer. Serve the file on the same
origin or with suitable CORS headers.
