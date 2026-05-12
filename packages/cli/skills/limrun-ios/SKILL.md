---
name: limrun-ios
description: "Replaces xcodebuild with remote XCode and Simulators, plus full iOS UI control. Use when the user wants to build, run, or launch an iOS app, test iOS UI, interact with the simulator (tap, click, type into, scroll), inspect the screen, capture a screenshot, or record a video. Triggers on phrases like 'run it', 'build it', 'test it', 'show me a screenshot', 'launch on simulator', 'tap the button', or 'type into the field'."
---

# Remote XCode & iOS Simulator

You are an iOS build-and-test operator. Your job is to get the user's iOS app running on a Limrun cloud simulator, verify it works, and iterate until the user is satisfied.

All builds and simulator operations run on Limrun and that's why you can build iOS
apps from any environments; linux, windows, macos, VM, container etc. Never try to
use local Xcode, local simulators, or local macOS build tools.

If `lim` CLI is not installed, you can install it with the following:

```bash
npm install --global @limrun/cli
```

## Check the CLI for current commands and flags

The CLI is the source of truth for command names, flags, and behavior. Before invoking any `lim` command you have not already used in this session, MUST run its `--help` first. The examples below are happy-path only; this skill intentionally does not embed the full reference because it would rot. Use:

```bash
lim ios --help                  # list all iOS subcommands
lim ios <subcommand> --help     # flags and examples for one iOS subcommand
lim xcode --help                # list all xcode subcommands
lim xcode <subcommand> --help   # flags and examples for one xcode subcommand
lim session --help              # list all session subcommands
lim session <subcommand> --help # flags and examples for one session subcommand
```

## Build and Reload

First, create an XCode & iOS Simulator pair:

```bash
# Add label selector depending on your identifiers. For example, Linear issue, repo name etc.
lim ios create --xcode \
  --reuse-if-exists \
  --label issue=<ISSUE ID> \
  --label repo=<Repo Name> \
  --label agent=<Your Agent Name>
```

The command output includes the instance ID (e.g. `ios_abc123`) and a `Signed Stream URL:`. Share that URL with the user so they can watch the simulator while you work. If you have a browser you can drive, open the URL in that browser and notify the user.

### Start a session for fast interaction

Right after creating the instance, start a session so subsequent interaction commands are fast:

```bash
# ID comes from the create output above. Always pass --id explicitly in agent workflows.
lim session start --id <instance-id>
```

Every `tap`, `type`, `element-tree`, `screenshot`, `record`, and `perform` command auto-routes through this session at ~50ms instead of ~2s. `lim ios delete` will auto-stop the session at cleanup; no separate `session stop` step is required.

### Build

Instead of `xcodebuild` command, you MUST use the following to build the iOS app.

```bash
lim xcode build .
```

Use `--scheme` and `--workspace` flags if the project has multiple schemes or uses a workspace file. This makes sure the files are synced with the remote xcode and triggers
a build where the build logs are streamed through stdout and stderr.

Every successful build will automatically re-install the app in iOS Simulator and re-launch it.

## Interacting with the App

Prefer tapping by accessibility identifier, then by label, then by coordinates as a last resort:

```bash
lim ios tap-element --ax-unique-id startButton
lim ios tap-element --ax-label "Save"
lim ios tap 201 450
```

After every interaction, re-run `element-tree` to confirm the UI transitioned correctly. No sleep is needed between a tap and element-tree.

For text input:

```bash
lim ios type "hello world"
```

## Testing Changes

After every build, test new or changed functionality by using interaction commands. Focus on what changed plus a quick smoke test of core flows.

Use element tree for functional assertions (element existence, labels, state changes). Use screenshots only for visual-only properties.
Use video recording for most accurate interaction tests such as animations, gameplay,
real experience etc.

Generally, start with getting an element tree:

```bash
lim ios element-tree
```

Then if a single action will be taken, just call it. For example:

```bash
lim ios tap-element --ax-label Continue
```

If you will take multiple actions, you can create a chain of actions to be executed
with precise timing.

Some examples:

```bash
lim ios perform --action type=tap,x=100,y=200 --action "type=typeText,text=Hello World"
```

```bash
lim ios perform --action type=wait,durationMs=1000 --action type=pressKey,key=enter
```

You can write to a file and execute that too:

```bash
lim ios perform --file ./actions.yaml
```

Use `lim ios perform --help` for more details on how to use it.

Video recording is available so you can review what the user sees while you are taking actions. For
any testing involving motion prefer video over screenshots for review.

Always include a demo video in the pull request so that user can see how it works.

Start recording (non-blocking):

```bash
lim ios record start
```

Stop and save recording:

```bash
lim ios record stop -o /tmp/recording.mp4
```

## Finalize

When you are wrapping up changes, produce a shareable build artifact so the user can test it themselves:

```bash
ASSET_NAME="<bundle-id-or-pr-number-or-session-identifier>.zip"
lim xcode build . --upload ${ASSET_NAME}
```

Then share a preview link with the user (substitute the asset name above):

```
https://console.limrun.com/preview?asset=${ASSET_NAME}&platform=ios
```

Always provide this in your last message.

## Cleanup

When the user is satisfied or the conversation is ending, always clean up:

```bash
lim ios delete
```

## Gotchas

These are common failure points. Check here first when something goes wrong.

- **Instance ID is optional.** The CLI remembers the last created instance. You only need to pass an ID explicitly when controlling multiple instances.
- **No sleep needed between `tap-element` and `element-tree`.** The tap blocks until complete.
- **`element-tree` can be large.** Pipe through `grep` or `jq` to extract what you need rather than dumping the full tree into context.
- **Build errors are your job to fix.** If a build fails, read the error output, fix the code, and rebuild. Do not ask the user to fix build errors.
- **Bundle ID discovery.** If you don't know the bundle ID, check the Xcode project files or run `lim ios list-apps` after a successful build.
