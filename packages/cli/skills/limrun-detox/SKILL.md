---
name: limrun-detox
description: Debug Detox on Limrun iOS simulators. Use when launching Expo Go or simulator apps with the Limrun Detox runtime, wiring Detox mediator connectivity, or validating app/tester connections over reverse tunnels.
---

# Limrun Detox

Use this for Detox runtime work on Limrun iOS. Keep build concerns separate unless the user explicitly asks for a native build.

## Components

- Tester: local Node/Jest/Detox process.
- Mediator: `detox run-server`, can run separately from the tester.
- App client: injected by limulator through the typed `runtime: { kind: "detox" }` launch path.

## Connectivity Pattern

Run the mediator locally:

```bash
npx detox run-server -p 8099 -l trace
```

Expose it to the simulator:

```bash
lim ios reverse 57091:8099 --id <ios-id>
```

Launch the app through the SDK with the Detox runtime:

```ts
await ios.launchApp('host.exp.Exponent', {
  mode: 'RelaunchIfRunning',
  runtime: {
    kind: 'detox',
    serverUrl: 'ws://<LISTEN_IP>:57091',
    sessionId: '<session-id>',
    version: '20.51.1',
  },
});
```

## Validation Signals

- App connected: `detox run-server` logs `role:"app"` and `appConnected:true`.
- Tester connected: same session returns `testerConnected:true, appConnected:true`.
- Runtime loaded: app connects to the mediator after launch.

## Gotchas

- The public launch API does not accept arbitrary env vars, app args, or injectable paths. Use the typed Detox runtime.
- Supported bundled Detox versions are exact. Unsupported versions should fail with a clear supported-version list.
- `detox run-server` showing `Cannot forward the message to the Detox client` can simply mean the app connected before the tester did.
- This does not make Detox own the iOS device lifecycle; prepare/reuse the Limrun instance separately for now.
