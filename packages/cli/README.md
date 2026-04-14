# @limrun/cli

The official command-line interface for [Limrun](https://limrun.com) — create and control cloud mobile sandboxes for Android, iOS, and Xcode.

## Installation

```bash
# npm
npm install -g @limrun/cli

# npx (no install)
npx @limrun/cli <command>
```

## Authentication

```bash
# Log in via browser (stores API key in ~/.lim/config.yaml)
lim login

# Or provide an API key directly
lim --api-key <YOUR_KEY> android list

# Or use an environment variable
export LIM_API_KEY=<YOUR_KEY>
lim android list

# Log out (removes stored API key)
lim logout
```

The CLI stores configuration in `~/.lim/config.yaml`. This file is compatible with the Go-based `lim` CLI — if you've already logged in with the Go version, the TypeScript CLI will use the same credentials.

## Global Flags

Every command supports these flags:

| Flag | Description |
|------|-------------|
| `--api-key <value>` | API key (also reads `LIM_API_KEY` env var) |
| `--json` | Output as JSON instead of human-readable tables |
| `--help` | Show help for any command |

## Command Structure

Commands are organized by resource (noun-first), so you can discover everything available for a platform with `--help`:

```bash
lim ios --help       # All iOS commands
lim android --help   # All Android commands
lim xcode --help     # All Xcode commands
lim asset --help     # All asset commands
```

**Top-level shortcuts** are available for common actions — the platform is auto-detected from the instance ID prefix:

```bash
lim screenshot <id>  # Works for both iOS and Android
lim tap <id> 100 200 # Auto-detects platform from ID prefix
lim delete <id>      # Auto-detects resource type from ID prefix
lim sync <id> ./path # Works for iOS and Xcode instances
lim build <id>       # Works for iOS and Xcode instances
```

## Commands

- [iOS](#ios) — Create, manage, and interact with iOS instances
- [Android](#android) — Create, manage, and interact with Android instances
- [Xcode](#xcode) — Create and manage Xcode sandbox instances
- [Assets](#assets) — Upload and download files (APKs, IPAs, etc.)
- [Sessions](#sessions) — Persistent connections for fast, interactive device control
- [Xcode Build Pipeline](#xcode-build-pipeline) — Sync code and run xcodebuild remotely

---

### iOS

```bash
lim ios create          # Create a new iOS instance
lim ios list            # List all ready iOS instances
lim ios list <ID>       # Get details of a specific instance
lim ios delete <ID>     # Delete an instance
```

#### Create Options

```bash
# Basic
lim ios create

# With specific device model
lim ios create --model ipad --rm

# With pre-installed app from asset storage
lim ios create --install-asset my-app.ipa

# With Xcode sandbox enabled
lim ios create --xcode

# Full options
lim ios create --region us-west --display-name "CI Test" --label env=ci --rm
```

**Flags for `ios create`:**

| Flag | Description |
|------|-------------|
| `--rm` | Auto-delete the instance on exit (Ctrl+C) |
| `--model <iphone\|ipad\|watch>` | Simulator device model |
| `--xcode` | Attach a Xcode build sandbox to the iOS instance |
| `--region <value>` | Region for the instance (e.g. `us-west`) |
| `--display-name <value>` | Human-readable name |
| `--label <key=value>` | Labels (repeatable). Used for filtering and reuse |
| `--hard-timeout <duration>` | Max lifetime (e.g. `1m`, `10m`, `3h`). Default: none |
| `--inactivity-timeout <duration>` | Idle timeout. Default: `3m` |
| `--reuse-if-exists` | Reuse an existing instance with matching labels/region |
| `--install <file>` | Local file to install (auto-uploads, repeatable) |
| `--install-asset <name>` | Asset name to install (repeatable) |

#### List and Filter

```bash
lim ios list                                   # Ready instances
lim ios list --all                             # All states
lim ios list --state creating                  # Filter by state
lim ios list --region us-west                  # Filter by region
lim ios list --label-selector env=prod         # Filter by labels
lim ios list --json                            # JSON output
```

#### Device Interaction

```bash
# Screenshots
lim ios screenshot <ID> -o screenshot.png
lim ios screenshot <ID>                     # Output base64 to stdout

# Tapping
lim ios tap <ID> 100 200
lim ios tap-element <ID> --label "Submit"
lim ios tap-element <ID> --accessibility-id btn_ok

# Text input
lim ios type <ID> "Hello World"
lim ios type <ID> "search query" --press-enter
lim ios press-key <ID> enter
lim ios press-key <ID> a --modifier shift

# Scrolling
lim ios scroll <ID> down --amount 500

# UI inspection
lim ios element-tree <ID>
lim ios element-tree <ID> | jq '.'

# Open URLs / deep links
lim ios open-url <ID> https://example.com
lim ios open-url <ID> myapp://settings
```

#### App Management (iOS only)

```bash
# Install an app (local file auto-uploads, or use URL)
lim ios install-app <ID> ./MyApp.ipa
lim ios install-app <ID> https://example.com/app.ipa

# Launch / terminate
lim ios launch-app <ID> com.example.myapp
lim ios launch-app <ID> com.example.myapp --mode RelaunchIfRunning
lim ios terminate-app <ID> com.example.myapp

# List installed apps
lim ios list-apps <ID>
```

#### Log Streaming (iOS only)

```bash
# Tail recent logs
lim ios log <ID> com.example.myapp --lines 50

# Stream logs continuously (Ctrl+C to stop)
lim ios log <ID> com.example.myapp -f
```

#### Video Recording

```bash
lim ios record <ID> start
lim ios record <ID> start --quality 8
lim ios record <ID> stop -o recording.mp4
```

#### Xcode Integration

```bash
# Sync and build (requires --xcode on create)
lim ios sync <ID> ./MyProject
lim ios build <ID> --scheme MyApp --workspace MyApp.xcworkspace
```

---

### Android

```bash
lim android create       # Create a new Android instance
lim android list         # List all ready Android instances
lim android list <ID>    # Get details of a specific instance
lim android delete <ID>  # Delete an instance
```

#### Create Options

```bash
# Basic (with ADB tunnel and scrcpy streaming)
lim android create

# With apps pre-installed
lim android create --install ./my-app.apk --install ./another.apk

# Without streaming
lim android create --no-stream

# Full options
lim android create --region us-west --display-name "CI Test" --label env=ci --rm
```

**Android-specific flags:**

| Flag | Description |
|------|-------------|
| `--[no-]connect` | Start ADB tunnel (default: true) |
| `--[no-]stream` | Launch scrcpy for visual control (default: true) |
| `--adb-path <path>` | Path to `adb` binary (default: `adb`) |

#### Device Interaction

```bash
# Screenshots
lim android screenshot <ID> -o screenshot.png

# Tapping
lim android tap <ID> 100 200
lim android tap-element <ID> --resource-id com.example:id/button
lim android tap-element <ID> --text "Sign In"

# Text input
lim android type <ID> "Hello World"
lim android press-key <ID> enter

# Scrolling
lim android scroll <ID> down --amount 500

# UI inspection
lim android element-tree <ID>

# Install app
lim android install-app <ID> ./app.apk

# Open URL
lim android open-url <ID> https://example.com

# Video recording
lim android record <ID> start
lim android record <ID> stop -o recording.mp4
```

#### ADB Tunnel

Connect to a running Android instance for direct `adb` access:

```bash
lim android connect <ID>
lim android connect <ID> --adb-path /usr/local/bin/adb
```

The tunnel stays open until you press Ctrl+C. While connected, you can use `adb` commands in another terminal.

---

### Xcode

Standalone Xcode build sandboxes for remote compilation.

```bash
lim xcode create          # Create a new Xcode sandbox
lim xcode list            # List all ready Xcode instances
lim xcode list <ID>       # Get details of a specific instance
lim xcode delete <ID>     # Delete an instance
```

```bash
# Create with options
lim xcode create --rm --region us-west --hard-timeout 1h

# Sync and build
lim xcode sync <ID> ./MyProject
lim xcode build <ID> --scheme MyApp --workspace MyApp.xcworkspace

# Build and upload artifact
lim xcode build <ID> --scheme MyApp --upload my-app-build
```

---

### Assets

Assets are files (APKs, IPAs, configs, etc.) stored in Limrun's cloud storage for use with instances.

```bash
# Upload a file
lim asset push ./my-app.apk
lim asset push ./my-app.ipa -n custom-name

# Download a file
lim asset pull asset_abc123
lim asset pull my-app.apk
lim asset pull asset_abc123 -o ./downloads

# List assets
lim asset list
lim asset list --name my-app
lim asset list --download-url

# Get a specific asset
lim asset list asset_abc123

# Delete an asset
lim asset delete asset_abc123
```

---

### Sessions

Sessions keep a persistent WebSocket connection to an instance in the background, making all interaction commands near-instant (~50ms instead of ~2s per command).

#### Why Sessions?

Without a session, every command creates a new connection:

```
lim ios screenshot ios_abc123      # ~2s (connect + auth + screenshot + disconnect)
lim ios tap ios_abc123 100 200     # ~2s (connect + auth + tap + disconnect)
lim ios element-tree ios_abc123    # ~2s (connect + auth + fetch + disconnect)
# Total: ~6s for 3 commands
```

With a session, the connection is created once and reused:

```
lim session start ios_abc123        # ~2s (one-time connection setup)
lim ios screenshot ios_abc123       # ~50ms (reuses connection)
lim ios tap ios_abc123 100 200      # ~50ms (reuses connection)
lim ios element-tree ios_abc123     # ~50ms (reuses connection)
lim session stop                    # instant cleanup
# Total: ~2.15s for 3 commands
```

This makes sessions essential for interactive workflows, AI agent loops, and any scenario where you run multiple commands against the same instance.

#### Session Commands

```bash
# Start sessions (one per instance, can run multiple)
lim session start ios_abc123
lim session start ios_def456
lim session start android_ghi789

# Check all active sessions
lim session status
lim session status --json

# Stop a specific session
lim session stop ios_abc123

# Stop all sessions at once
lim session stop --all
```

If only one session is active, `lim session stop` (no ID) stops it automatically.

#### How It Works

Each `lim session start <ID>` spawns an independent background daemon that:
- Holds a persistent WebSocket connection to that specific instance
- Listens on its own Unix socket at `/tmp/lim-sessions/<instance-id>/`
- All interaction commands automatically detect the matching session and route through it
- Multiple sessions run in parallel with no shared state

#### Example: Interactive Testing

```bash
lim ios create --model iphone
lim session start ios_abc123

# Fast interaction loop — each command takes ~50ms
lim ios launch-app ios_abc123 com.example.myapp
lim ios element-tree ios_abc123 | jq '.tree'
lim ios tap-element ios_abc123 --label "Login"
lim ios type ios_abc123 "user@example.com"
lim ios tap-element ios_abc123 --label "Submit"
lim ios screenshot ios_abc123 -o after-login.png

lim session stop ios_abc123
lim ios delete ios_abc123
```

#### Example: Multi-Device AI Agent

```bash
# Create two instances and start sessions for both
lim ios create --model iphone
lim ios create --model ipad
lim session start ios_phone_123
lim session start ios_tablet_456

# Agent controls both devices in parallel — ~50ms per command
lim ios launch-app ios_phone_123 com.example.myapp
lim ios launch-app ios_tablet_456 com.example.myapp

lim ios screenshot ios_phone_123 -o phone.png
lim ios screenshot ios_tablet_456 -o tablet.png

lim ios tap ios_phone_123 200 400
lim ios element-tree ios_tablet_456 --json > tablet-tree.json

# Clean up all sessions
lim session stop --all
lim ios delete ios_phone_123
lim ios delete ios_tablet_456
```

#### Example: Automated Test Matrix

```bash
# Spin up devices, start sessions, run tests, tear down
DEVICES=("iphone" "ipad")
IDS=()

for model in "${DEVICES[@]}"; do
  ID=$(lim ios create --model $model --json | jq -r '.metadata.id')
  lim session start $ID
  IDS+=($ID)
done

# Run tests against all devices
for ID in "${IDS[@]}"; do
  lim ios launch-app $ID com.example.myapp
  lim ios screenshot $ID -o "test_${ID}.png"
done

# Tear down
lim session stop --all
for ID in "${IDS[@]}"; do
  lim delete $ID
done
```

---

### Xcode Build Pipeline

Build and test iOS apps remotely using cloud Xcode sandboxes. The `sync` and `build` commands work with both standalone Xcode instances and iOS instances that have Xcode sandbox enabled.

#### Option A: iOS Instance with Xcode Sandbox (Recommended)

This gives you a simulator **and** a build environment in one instance — the built app is automatically installed on the simulator.

```bash
# 1. Create iOS instance with Xcode sandbox
lim ios create --xcode
# Output:
#   Instance ID: ios_abc123
#   Xcode Sandbox: https://...limrun.net/v1/sandbox_.../xcode
#   (sandbox URL is cached locally for sync/build to use)

# 2. Sync your project code to the Xcode sandbox
lim ios sync ios_abc123 ./MyProject

# 3. Build — the app is auto-installed on the simulator
lim ios build ios_abc123 --scheme MyApp --workspace MyApp.xcworkspace

# 4. Start a session for fast device interaction
lim session start ios_abc123

# 5. Test the built app on the simulator (~50ms per command)
lim ios launch-app ios_abc123 com.example.myapp
lim ios element-tree ios_abc123 | jq '.'
lim ios screenshot ios_abc123 -o built-app.png

# 6. Clean up
lim session stop ios_abc123
lim ios delete ios_abc123
```

> **Note:** The Xcode sandbox URL is only returned when the instance is created — not on subsequent `list` calls. The CLI caches it locally at `~/.lim/instances/` so that `sync` and `build` can find it. This means `sync`/`build` must run on the same machine where `ios create --xcode` was executed.

#### Option B: Standalone Xcode Instance

Use this when you only need to build (no simulator needed), or when you want to attach a simulator separately.

```bash
# 1. Create a standalone Xcode instance
lim xcode create --rm

# 2. Sync and build
lim xcode sync xcode_abc123 ./MyProject
lim xcode build xcode_abc123 --scheme MyApp --workspace MyApp.xcworkspace

# 3. Upload build artifact
lim xcode build xcode_abc123 --scheme MyApp --upload my-app-build

# 4. Download the artifact
lim asset pull my-app-build -o ./build-output
```

#### Sync Options

```bash
# Watch mode (re-syncs on file changes, default)
lim ios sync ios_abc123 ./MyProject --watch

# One-shot sync (no watch)
lim ios sync ios_abc123 ./MyProject --no-watch

# Sync without installing
lim ios sync ios_abc123 ./MyProject --no-install
```

The sync automatically ignores build artifacts (`build/`, `DerivedData/`, `.build/`), dependency folders (`Pods/`, `Carthage/Build/`, `.swiftpm/`), and user-specific files (`xcuserdata/`, `.dSYM/`).

---

## Configuration

The CLI reads configuration from multiple sources (in order of precedence):

1. Command-line flags (`--api-key`)
2. Environment variables (`LIM_API_KEY`, `LIM_API_ENDPOINT`, `LIM_CONSOLE_ENDPOINT`)
3. Config file (`~/.lim/config.yaml`)

**Config file keys:**

| Key | Default | Description |
|-----|---------|-------------|
| `api-key` | — | Your Limrun API key |
| `api-endpoint` | `https://api.limrun.com` | API base URL |
| `console-endpoint` | `https://console.limrun.com` | Console URL (for login) |

---

## JSON Output

All commands support `--json` for machine-readable output, making the CLI suitable for scripting and AI agent automation:

```bash
# Get instance details as JSON
lim ios list ios_abc123 --json

# Parse with jq
lim android list --json | jq '.[].metadata.id'

# Use in scripts
INSTANCE_ID=$(lim ios create --json | jq -r '.metadata.id')
lim ios screenshot $INSTANCE_ID -o test.png
lim delete $INSTANCE_ID
```

---

## Workflows

### CI Testing: Install and Verify an App

```bash
INSTANCE_ID="ios_..."

# Create instance and start session for fast commands
lim ios create --install ./build/MyApp.ipa
lim session start $INSTANCE_ID

# Verify — each command takes ~50ms with session
lim ios launch-app $INSTANCE_ID com.example.myapp
sleep 2
lim ios element-tree $INSTANCE_ID | grep "Welcome"
lim ios screenshot $INSTANCE_ID -o test-result.png

# Clean up
lim session stop $INSTANCE_ID
lim delete $INSTANCE_ID
```

### AI Agent Automation

```bash
# Create instance
INSTANCE=$(lim ios create --model iphone --json)
ID=$(echo $INSTANCE | jq -r '.metadata.id')

# Start session — all commands now run in ~50ms
lim session start $ID

# Agent can interact at high speed
lim ios tap $ID 200 400
lim ios type $ID "test@example.com"
lim ios tap-element $ID --label "Sign In"
lim ios screenshot $ID -o result.png
lim ios element-tree $ID --json > ui-state.json

# Tail logs (non-streaming works through session too)
lim ios log $ID com.example.myapp --lines 20

# Clean up
lim session stop $ID
lim delete $ID
```

### Remote Build + Test on iOS Simulator

```bash
# Single instance: Xcode sandbox + iOS simulator
ID=$(lim ios create --xcode --json | jq -r '.metadata.id')

# Sync, build, and test
lim ios sync $ID ./MyiOSProject --no-watch
lim ios build $ID --scheme MyApp --workspace MyApp.xcworkspace

# Verify the built app on the simulator
lim session start $ID
lim ios launch-app $ID com.example.myapp
sleep 2
lim ios element-tree $ID | grep "Welcome"
lim ios screenshot $ID -o test-result.png
lim session stop

lim delete $ID
```

### Build-Only with Artifact Upload

```bash
lim xcode create --rm --reuse-if-exists --label project=myapp
XCODE_ID="xcode_..."

lim xcode sync $XCODE_ID ./MyiOSProject --no-watch
lim xcode build $XCODE_ID --scheme MyApp --workspace MyApp.xcworkspace --upload myapp-latest
lim asset pull myapp-latest -o ./build-output
```

---

## Development

### Setup

```bash
cd packages/cli
npm install
npm run build
```

### Run commands during development

```bash
# After making changes, rebuild and run
npm run build && node bin/run.js <command>

# Or use watch mode in one terminal, run in another
npx tsc --watch           # Terminal 1
node bin/run.js ios list   # Terminal 2
```

### Link globally

```bash
npm link

# Now `lim` works anywhere on your machine
lim --help
lim android list

# Unlink when done
npm unlink -g @limrun/cli
```
