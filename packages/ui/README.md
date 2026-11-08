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

## Playback buffering

`jitterBufferTargetMs` sets a preferred browser jitter buffer duration for incoming
audio and video on Android and iOS streams. It accepts finite numbers from 0 to
4000 milliseconds. For example:

```tsx
<RemoteControl url={instanceWebsocketUrl} token={instanceToken} jitterBufferTargetMs={50} />
```

The default is the browser's automatic buffering. Changing the prop updates active
receivers without reconnecting and applies to new receivers after a reconnect.
Remove the prop or set it to `null` to restore automatic buffering. Browsers without
`RTCRtpReceiver.jitterBufferTarget` ignore the prop. Invalid values produce a console
warning and leave the receiver's previous target unchanged.

The target is a preference, not a maximum buffer size or an end-to-end latency
guarantee. A lower value can reduce playback delay but increase dropped frames,
freezes, or audio interruptions on unstable connections. The browser can use a
different duration and can adjust gradually. Compare first-frame latency after idle,
steady playback, and drops or freezes on your target browsers and networks before
choosing a value. The example's 50 ms is not a recommended default.

## Playback measurements

Pass `onPlaybackStats` to receive browser measurements for incoming iOS and
Android streams, including phones, tablets, Apple Watch, and both Duo displays.
The callback and its types are available from `@limrun/ui` and `@limrun/ui/lite`.

```tsx
import { useState } from 'react';
import { RemoteControl, type PlaybackStats } from '@limrun/ui';

function Player({ url, token }: { url: string; token: string }) {
  const [stats, setStats] = useState<PlaybackStats | null>(null);
  const primary = stats?.video.find((video) => video.display === 'primary');
  return (
    <>
      <RemoteControl url={url} token={token} onPlaybackStats={setStats} />
      <output>Buffer delay: {primary?.bufferDelayMs?.toFixed(1) ?? '—'} ms</output>
    </>
  );
}
```

Collection uses the existing connection about every two seconds while the callback
is set and the tab is visible. Removing the callback stops collection. A disconnect,
hidden tab, or collection error emits `null` once after a measurement. Resuming or
reconnecting starts a fresh baseline. Changing the callback function does not reconnect
or restart collection. No stats requests run without a subscriber.

`PlaybackStats` contains `video` and `audio` arrays, a Unix-millisecond `timestamp`,
`requestedTargetMs`, and optional selected-connection `rttMs`. A `null` target means
automatic buffering. An invalid target prop leaves this field undefined. The requested
target does not confirm browser support or the duration actually used.

Each track has `id`, `trackId`, `timestamp`, and optional `intervalMs`,
`bufferDelayMs`, and `bitrateBps`. Video adds `display`, `fps`, `droppedFrames`, and
`freezes`. Duo's `primary` and `inner` displays stay separate. Audio is empty when
the connection has no incoming audio stream. Camera and microphone uploads are excluded.

Rates and counts describe the interval since that stream's previous sample.
Buffer delay divides the change in accumulated jitter-buffer delay by the change
in emitted frames or audio samples. FPS uses decoded frames; freezes count only
browser-reported freezes that have completed. Missing browser fields, the first
sample, and reset counters leave affected measurements undefined. A buffer with
no emitted frames has no delay measurement; it is not zero. Static screens may
have low FPS. These measurements do not include tap-to-screen latency or server
encoding time.

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

## Latency diagnostics

Pass `onTrace={(message) => ...}` to receive each parsed diagnostic message
from supported single-display iOS and Android instances. Omitting the callback leaves tracing off.
Adding or removing it reconnects the stream; replacing the callback does not.
Older servers keep streaming normally without diagnostics.

Both platforms use the same versioned messages, input sequences, and frame records.
See [latency diagnostics](https://docs.limrun.com/platform/embed-simulator#latency-diagnostics)
for the event fields and measurement limits.

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

## Build a custom device viewer

Import `createDeviceStream` from `@limrun/ui/core` when you supply your own UI.
This browser entry has no React, CSS, or device-artwork imports. It uses the same
connection, input, playback, camera, microphone, and accessibility implementation
as `RemoteControl`. A browser WebView can use it too; it is not a Node.js WebRTC client.

Attach your video element before starting the session. Use the instance WebSocket
URL and instance token returned by the Limrun API, not your organization API key.

```ts
import { createDeviceStream } from '@limrun/ui/core';

function mountDevice(video: HTMLVideoElement, url: string, token: string) {
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const stream = createDeviceStream({
    url,
    token,
    autoReconnect: true,
    onStateChange: (state) => console.log(state.connection, state.controlReady),
    onPlaybackStats: (stats) => console.log(stats),
  });
  stream.attachVideo(video);
  stream.start();

  return {
    home: () => stream.pressButton('home'),
    screenshot: () => stream.screenshot(),
    unmount: () => stream.dispose(),
  };
}
```

For a canvas or texture renderer, replace `attachVideo` with `attachFrameSink`.
The core owns the video element and playback workaround, then delivers decoded
frames. The frame is borrowed: draw or copy it before `present` returns.

```ts
stream.attachFrameSink({
  present(source, width, height) {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.getContext('2d')?.drawImage(source, 0, 0, width, height);
  },
});
```

Both attachment methods return a detach function. `stop()` closes the connection
and releases capture devices while retaining renderer attachments for `start()`.
`dispose()` also detaches every renderer and permanently closes the client.
Neither method terminates the Limrun instance.

Map your pointer events to frame pixels and call
`sendTouch(phase, x, y, width, height, pointerId)`. The phases are `begin`, `move`,
and `end`. Use `sendKeyEvent`, `sendText`, `pressButton`, and `rotate` for other
input. `sendControl` accepts messages built by the exported protocol helpers.

For Duo devices, attach a second renderer with display `'inner'`. The core
negotiates both tracks and reports the native display geometry through
`getState().duoState` and `onStateChange`. Use `sendDisplayTouch` with the native
`screenId` for panel input, or `sendDuoControl` for hinge and orientation commands.

For a single-panel viewer, `getDuoDisplay(state)` selects the outer or inner
panel using the same hinge threshold as `RemoteControl`. `DuoTouchController`
converts normalized viewer coordinates into native panel coordinates and
releases a held touch before changing displays or rotation:

```ts
import { DuoTouchController, getDuoDisplay } from '@limrun/ui/core';

const touch = new DuoTouchController((...args) => stream.sendDisplayTouch(...args));
// Update whenever the selected display or its orientation changes.
touch.setDisplay(getDuoDisplay(stream.getState().duoState));
touch.touch('begin', 0.25, 0.5);
touch.touch('move', 0.5, 0.5);
touch.touch('end', 0.5, 0.5);
// Also release on lost pointer capture, blur, disconnect, or viewer disposal.
touch.release();
```

`setDisplay` defaults to the native display orientation. Pass a second argument
in clockwise quarter turns when your frame uses a different visual rotation.
Pass `true` as the fourth argument to `touch` for coordinates already mapped to
the native panel. `flatDisplayTouch` and `panelTouch` are available separately
for flat-view coordinates and 3D mesh UVs. `HingeSender` coalesces slider updates
while a hinge command is in flight; call `stop()` when disposing the viewer.

Enable accessibility polling with `inspectMode: true`, receive snapshots with
`onAxSnapshotChange`, and request a fresh tree with `refreshAxTree()`. Camera and
microphone demand use the same browser permission prompts and callbacks as
`RemoteControl`. Your application remains responsible for instance creation and
termination, UI gestures, and any accessibility overlay.

### Connect through your own proxy

Supply a transport when your backend authenticates the upstream WebSocket.
Return a fresh socket on each call, since reconnects call `connect()` again.
The client owns and closes that socket. Supply `platform` explicitly because a
proxy URL does not identify the device kind.

```ts
const stream = createDeviceStream({
  platform: 'ios',
  autoReconnect: true,
  transport: {
    connect: () => new WebSocket(authenticatedProxyUrl),
  },
});
```

The proxy forwards Limrun's signaling messages unchanged. Video and control data
still travel over WebRTC. The core does not append a Limrun token to a custom
transport URL. You can fetch a fresh proxy ticket inside an asynchronous
`connect()` implementation.

If your backend can authoritatively report instance termination, implement
`transport.isTerminated(): Promise<boolean>`. Without it, proxy failures use the
normal retry policy. The core does not infer termination from a proxy's HTTP status.

Call `updateOptions` to change callbacks, accessibility polling, microphone
capture, reconnect policy, or the jitter buffer preference without replacing the
connection. A newly enabled `onTrace` callback takes effect on the next reconnect,
because tracing requires negotiation. Create a new client when changing the
instance, transport, platform, or session ID.

### Watch-only access

Mint `ios:<instance-id>:watch` or `android:<instance-id>:watch` through
`lim.accessTokens.create({ permissions: [...], ttlSeconds: 900 })` on your backend.
Supply the instance's streaming URL and the resulting token to the viewer:

```tsx
<RemoteControl url={streamingUrl} token={watchToken} />
```

`RemoteControl` derives watch-only mode from a signed `lim_st_` token's scopes for
the device ID in the streaming URL. A matching `stream` or `all` grant keeps it
interactive. Set `watchOnly` to restrict an interactive token too; `false` cannot
override a watch-only token. Opaque or malformed tokens, and URLs without a device
ID in their path, use the explicit prop instead. Token decoding controls the UI;
the server verifies and enforces the token.

Core does not inspect tokens. Custom renderers use `createDeviceStream({ url: streamingUrl, token: watchToken,
watchOnly: true })`. Proxy transports also accept `watchOnly: true`.

Video, screenshots, and accessibility reads remain available. Input and outbound
camera/microphone media are disabled; `controlReady` stays false. Mutating promise
methods reject with `Device is watch-only`; fire-and-forget input methods send
nothing. Changing `watchOnly` on `RemoteControl` reconnects the stream. For core,
create a new client to change this creation-time option.

Use the option with a `watch` token: only the token enforces access on the server.
Existing `stream` tokens remain interactive, and `read` grants metadata access,
not screen access.
