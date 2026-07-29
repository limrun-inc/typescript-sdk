# Limrun React Components

`@limrun/ui` contains the React components needed to embed Limrun instances
in web applications. It exports `RemoteControl` plus accessibility snapshot
types and helpers for building inspect, search, and agent interfaces.

See [examples](../../examples/) to see how it can be used.

## 3D view

`RemoteControl` can render the live stream on an interactive 3D device model
instead of the flat frame — pass `view="3d"`. Move the cursor and the device
subtly turns to face it; grab it to rotate, flick it to spin, and it gently
settles back to face you. The 3D view is presentation-only: device input is
disabled while it is active, and the underlying session stays connected so
flipping back to `view="2d"` is instant.

The 3D subsystem is fully lazy: the rendering engine (three.js and the
`Device3D` component) is code-split behind a dynamic import that only
resolves the first time a `RemoteControl` switches to `view="3d"`, and the
photoreal device models (~1 MB each, CC BY 4.0 — see
[CREDITS.md](./CREDITS.md)) are a further dynamic import fetched only when
the 3D view shows that particular device. Apps that never use the 3D view
download none of it. While a model downloads, an instant procedurally-built
placeholder is shown (and kept as fallback if the load fails).

Apple Watch simulators are detected automatically from their nearly square
stream; use the `deviceModel` prop (`'auto' | 'phone' | 'watch'`) to force
the model.

Related browser workflow packages are published separately:

- `@limrun/apple-auth` handles Apple ID login, signing credentials, and App
  Store Connect.
- `@limrun/device-install` handles WebUSB pairing and real-device installation.
- `@limrun/play-auth` handles Google login and Google Play publishing.

## Releasing

This package is not part of generated SDK, hence you need to publish it manually in GitHub Actions.
