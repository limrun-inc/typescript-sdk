---
name: limrun-skill
description: "Replaces xcodebuild with remote XCode and Simulators. Use when the user wants to build or run an iOS app, test iOS UI, see their app on a simulator, or says 'run it', 'build it', 'test it', 'show me a screenshot', or 'launch on simulator'."
user-invocable: true
effort: high
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

## Build and Reload

First, create an XCode & iOS Simulator pair:
```bash
# Add label selector depending on your identifiers. For example, Linear issue, repo name etc.
lim ios create --xcode \
  --reuse-if-exists \
  --label issue=<ISSUE ID> \
  --label repo=<Repo Name> \
  --label agent=<Your Agent Name>
# Example call: lim xcode create --reuse-if-exists --label issue=LIM-34 --label repo=sample-native-app --label agent=cursor
```

In the command output, there will be a signed stream URL. Share that with user so that they can watch the simulator while you are working.
If you have a browser that user can see, open the signed stream URL in that browser and notify the user.

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

When you are done with the changes and present to the user, you should provide a
preview link to the user so they can test it.

If you will open a PR, make sure to do this and add the preview link to PR.

First build and make remote xcode upload the build:
```
ASSET_NAME="<bundle id/pr number/ or any session identifier>.zip"
lim xcode build . --upload ${ASSET_NAME}
```

And construct this link for preview:
```
# Change ${ASSET_NAME} with asset name given above
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

## References

```bash
> lim ios
Execute any task on remote iOS Simulators: create, list, get, delete, info, list-apps, launch-app, terminate-app, app-log, syslog, sync, screenshot, tap, tap-element, element-tree, type, press-key, toggle-keyboard, scroll, open-url, install-app, record, perform, simctl, cp, xcrun, xcodebuild, lsof

USAGE
  $ lim ios COMMAND

COMMANDS
  ios app-log          Stream or tail app logs from a running iOS instance
  ios cp               Copy a local file into the iOS sandbox
  ios create           Create a new iOS instance
  ios delete           Delete an iOS instance
  ios element-tree     Get the UI element tree from a running iOS instance
  ios get              Get details for a specific iOS instance
  ios info             Get device information from a running iOS instance
  ios install-app      Install an app on a running iOS instance
  ios launch-app       Launch an app on a running iOS instance
  ios list             List iOS instances
  ios list-apps        List installed apps on a running iOS instance
  ios lsof             List open files on a running iOS instance
  ios open-url         Open a URL on a running iOS instance
  ios perform          Perform multiple iOS actions in a single batch
  ios press-key        Press a key on a running iOS instance
  ios record           Start or stop video recording on a running iOS instance
  ios screenshot       Capture the current screen from a running Android instance and save the image to a file.
  ios scroll           Scroll on a running iOS instance
  ios simctl           Run simctl on a running iOS instance
  ios sync             Sync a built app bundle to a running iOS instance
  ios syslog           Stream syslog from a running iOS instance
  ios tap              Tap at coordinates on a running iOS instance
  ios tap-element      Tap an iOS element by accessibility selector
  ios terminate-app    Terminate an app on a running iOS instance
  ios toggle-keyboard  Toggle the iOS software keyboard
  ios type             Type text into the focused iOS input field
  ios xcodebuild       Run xcodebuild on a running iOS instance
  ios xcrun            Run xcrun on a running iOS instance
```

```bash
> lim ios perform --help
Perform multiple iOS actions in a single batch

USAGE
  $ lim ios perform [--api-key <value>] [--json] [--quiet] [--create]
    [--id <value>] [--action <value>...] [-f <value>] [--timeout <value>]

FLAGS
  -f, --file=<value>
      Path to a YAML or JSON file containing an array of action objects.

      JSON example:
      [
      { "type": "tap", "x": 100, "y": 200 },
      { "type": "typeText", "text": "Hello World" }
      ]

      YAML example:
      - type: tap
        x: 100
        y: 200
      - type: typeText
        text: "Hello World"

  --action=<value>...
      Action definition as comma-separated key=value pairs; repeat for multiple
      actions.

      Available action types:
      - Tap on coordinate: type=tap,x=100,y=200
      - Tap on element by using a selector:
      type=tapElement,selector={"AXLabel":"Submit"}
      - Increment an element by using a selector:
      type=incrementElement,selector={"AXLabel":"Volume"}
      - Decrement an element by using a selector:
      type=decrementElement,selector={"AXLabel":"Volume"}
      - Set an element value by using a selector:
      type=setElementValue,text=42,selector={"AXLabel":"Counter"}
      - Type text into the focused field: type=typeText,text=Hello
      World,pressEnter=true
      - Press a key with optional modifiers:
      type=pressKey,key=a,modifiers=["shift"]
      - Scroll the screen:
      type=scroll,direction=down,pixels=300,coordinate=[200,400],momentum=0.2
      - Toggle the software keyboard: type=toggleKeyboard
      - Open a URL or deep link: type=openUrl,url=https://example.com
      - Set device orientation: type=setOrientation,orientation=Landscape
      - Wait before the next action: type=wait,durationMs=1000
      - Start a touch gesture: type=touchDown,x=100,y=200
      - Move a touch gesture: type=touchMove,x=120,y=220
      - End a touch gesture: type=touchUp,x=120,y=220
      - Press a raw key code down: type=keyDown,keyCode=4
      - Release a raw key code: type=keyUp,keyCode=4
      - Press a hardware button down: type=buttonDown,button=home
      - Release a hardware button: type=buttonUp,button=home

      Use JSON values for complex fields like selector, modifiers, and coordinate.

  --api-key=<value>
      [env: LIM_API_KEY] API key to use for this command. Overrides the saved
      login and can also be provided via LIM_API_KEY.

  --[no-]create
      Create a replacement instance automatically if the target instance is not
      found.

  --id=<value>
      iOS instance ID to target. Defaults to the last created iOS instance.

  --json
      Output structured JSON instead of human-readable tables or plain text when
      the command supports it.

  --quiet
      Suppress intermediate human-readable logs and only emit the final result.

  --timeout=<value>
      Override the total batch timeout in milliseconds. By default the CLI grows
      the timeout based on waits and action count.

DESCRIPTION
  Perform multiple iOS actions in a single batch

  Run a batch of iOS actions in a single CLI invocation using repeated
  `--action` flags or a JSON/YAML action file. This is the best choice for
  agent-driven multi-step interactions that should execute without reconnecting
  between steps.

EXAMPLES
  $ lim ios perform --action type=tap,x=100,y=200 --action "type=typeText,text=Hello World"

  $ lim ios perform --action type=wait,durationMs=1000 --action type=pressKey,key=enter

  $ lim ios perform --file ./actions.yaml
```

```bash
> lim xcode
Execute any task on remote XCode sandboxes: create, list, get, delete, sync, build, attach-simulator

USAGE
  $ lim xcode COMMAND

COMMANDS
  xcode attach-simulator  Attach an iOS simulator to an Xcode instance
  xcode build             Run xcodebuild on an Xcode sandbox
  xcode create            Create a new Xcode instance
  xcode delete            Delete an Xcode instance
  xcode get               Get details for a specific Xcode instance
  xcode list              List Xcode instances
  xcode sync              Continuously sync local source code to an Xcode
                          sandbox
```