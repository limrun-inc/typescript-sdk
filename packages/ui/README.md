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

## Device information

`RemoteControl` reads iOS device information over its existing signaling socket. It shows
an iPhone frame while device information loads, then selects the iPhone, iPad, or Apple
Watch frame from the model. Duo uses the runtime's folding capability. The iPad frame
rotates with the video; iPad and Watch screen openings fit the video's aspect ratio. Set `showFrame` explicitly to override automatic
frame visibility. The Watch crown, side button, and band are decorative; interact with
its screen as usual.

Custom iOS artwork uses `assets.ios.tabletFrame`, `tabletFrameLandscape`, and `watchFrame`.
Match the bundled SVGs' centered screen openings when replacing them. The lite entry
still includes no artwork, and missing device-specific artwork renders frameless.

Use `onDeviceInfoChange` for a surrounding title or controls. It receives
`{ model, name?, foldSupported }` and resets to `null` when the connection parameters change.
The metadata request does not open another connection or delay streaming. Android keeps
its existing frame behavior and does not request iOS device information.

```tsx
<RemoteControl url={instanceWebsocketUrl} token={instanceToken} onDeviceInfoChange={setDeviceInfo} />
```

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

`RemoteControl` discovers native Duo support and starts in 2D with native video
inside a silver Duo frame, including its hinge spine and physical buttons.
Both modes share the fold, hinge-angle and rotation toolbar. No model prop is required. Select **3D**
to load the interactive frame and its model on demand. Returning to **2D** releases
the renderer and its graphics resources without reconnecting the simulator.

```tsx
import { RemoteControl } from '@limrun/ui';

<RemoteControl url={instanceWebsocketUrl} token={instanceToken} deviceModel="iphone-duo" showFrame />;
```

The built-in 2D frame and procedural 3D model ship with the UI package; customers
do not need to host a model file. `deviceModel` can be omitted when native Duo
capabilities are discovered from the connection. The CLI and API control the
simulator; the UI package renders its frame.

Set `showFrame={false}` for the active display alone, without the frame, hardware
buttons, viewer toolbar, or 2D/3D toggle. Touch and keyboard input still work, and
the video follows display and orientation changes without loading a 3D renderer.

Use the hinge slider for any angle from 0° closed to 180° flat. In 2D, the active
display stays flat between folds. A brief folding animation shows the silver frame, hinge and buttons
when switching displays; 3D shows the physical hinge pose continuously. Touch and drag
on the visible display interact with iOS. In 3D, position starts unlocked. Drag the frame or
background, or Alt-drag the screen, to rotate the view. Use Lock position to prevent
rotation. Rotate device changes the native orientation. Laptop view sets the
hinge and orientation; it does not enable Apple's separate Table Mode.

In either mode, click the frame's Sleep/Wake, Volume Up, or Volume Down buttons to send native
hardware input. Press and hold is supported. These buttons remain active while
the position is locked. Hover near an edge to reveal its button icons, then click
either the icon or the physical button. Volume icons appear together above their
edge; Sleep/Wake appears beside its edge. Icons follow native rotation and folding.
Hover raises the physical button slightly without changing the camera framing.
Tab, Space and Enter also operate the icons. Camera Control is not yet supported.

The optional 2D fold animation loads a small WebGL renderer on demand and releases it after each fold.
Reduced motion or unavailable WebGL keeps the flat display. The full 3D view requires WebGL and renders when video frames arrive or the view changes,
and pauses while hidden. Duo currently supports single-finger gestures;
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
video. Optimized models may instead mark those mesh nodes with `extras.sourceDisplay`
set to `inner` or `outer`, so material deduplication preserves display identity.
Hardware meshes under `stationary-half` must carry `extras.button` with
`side`, `volumeUp`, or `volumeDown`. All three are required. This is a prepared Duo
appearance contract, not a general-purpose GLB viewer. Serve the file on the same
origin or with suitable CORS headers.
