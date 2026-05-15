---
name: limrun-detox
description: Configure, run, or debug Detox on Limrun iOS simulators. Use when attaching the Limrun Detox runtime to an app, wiring Detox mediator connectivity, or validating app/tester connections over reverse tunnels.
---

# Limrun Detox

Use this for Detox runtime work on Limrun iOS. Keep build concerns separate unless the user explicitly asks for a native build.

## Components

- Tester: local Node/Jest/Detox process.
- Mediator: `detox run-server`, usually local to the agent machine.
- App client: injected by limulator through `lim ios launch-app --runtime detox`.

## CLI Flow

Check current help before running commands you have not used in this session:

```bash
lim ios reverse --help
lim ios launch-app --help
```

Typical sequence:

```bash
# Start the Detox mediator locally.
npx detox run-server -p 8099 -l verbose

# Expose the mediator to the simulator.
lim ios reverse 57091:8099 --id <ios-id>

# Relaunch the app with the managed Detox runtime. Use the remote endpoint
# printed by `lim ios reverse`, not 127.0.0.1 on the user machine.
# --detox-version is optional when running from the project with node_modules/detox.
lim ios launch-app <bundle-id> \
  --id <ios-id> \
  --runtime detox \
  --detox-server-url ws://<reverse-remote-host>:57091 \
  --detox-session-id <session-id> \
  --detox-version <detox-version>

# Run the tester with the same server/session.
npx detox test --no-start
```

Prefer starting the tester before the app connects, or use the maintained orchestration in `examples/detox-ios`, to avoid benign mediator "cannot forward" noise.
If you manually launch the app before `npx detox test --no-start`, that mediator message is expected until the tester connects.

## Detox Test Setup

`npx detox test --no-start` still needs the normal Detox project configuration:

- Pass the Detox config file and configuration name from your project (see `examples/detox-ios/.detoxrc.cjs` for a reference layout).
- Use the Limrun third-party driver: `type: '@limrun/detox/driver'`.
- Keep `DETOX_SERVER` and `DETOX_SESSION_ID` aligned with the mediator and launch command.
- Provide Limrun driver env such as `LIMRUN_IOS_ID`, `LIMRUN_IOS_API_URL`, and `LIMRUN_IOS_TOKEN` when screenshots or driver calls need the instance API.

Use `examples/detox-ios` as the maintained happy path for exact config/env wiring. Use `-l trace` on `detox run-server` only when verbose logs are not enough.

For native SwiftUI apps, a minimal Detox configuration usually looks like:

```js
module.exports = {
  testRunner: { args: { $0: 'jest' }, jest: { setupTimeout: 120000 } },
  apps: { ios: { type: 'ios.app', binaryPath: 'unused-by-limrun' } },
  devices: {
    limrun: {
      type: '@limrun/detox/driver',
      device: { id: process.env.LIMRUN_IOS_ID },
    },
  },
  configurations: {
    'ios.limrun': {
      device: 'limrun',
      app: 'ios',
      behavior: { init: { reinstallApp: false }, cleanup: { shutdownDevice: false } },
    },
  },
};
```

Then launch with `lim ios launch-app <bundle-id> --runtime detox ...` and run `npx detox test --no-start`.

## Validation Signals

- App connected: `detox run-server` logs `role:"app"` and `appConnected:true`.
- Tester connected: the same session reaches `testerConnected:true, appConnected:true`.
- Runtime loaded: the app connects to the mediator after the `--runtime detox` launch.
- UI visible: `lim ios element-tree --id <ios-id>` shows the expected app screen.

## Gotchas

- Do not pass arbitrary env vars, app args, or injectable paths. Use `--runtime detox`.
- `--detox-version` should match the local `detox` package version used by the tester. If omitted, `lim ios launch-app` resolves it from the current working directory; pass it explicitly when running outside the Detox project.
- Unsupported bundled Detox versions should fail with a clear supported-version list.
- `Cannot forward the message to the Detox client` can simply mean the app connected before the tester did.
- For SwiftUI, prefer stable accessibility identifiers, e.g. `.accessibilityIdentifier("greetingText")` with `by.id('greetingText')`; `by.text(...)` can miss labels that appear in `lim ios element-tree`.
- Debug failures by checking `lim ios element-tree --id <ios-id>` first, then mediator logs for app/tester connection state.
- Cleanup manual runs by stopping `detox run-server`, stopping `lim ios reverse`, and deleting the instance with `lim ios delete <ios-id>` (`--id` is not valid for delete).
- This does not make Detox own the iOS lifecycle; prepare or reuse the Limrun instance separately.
