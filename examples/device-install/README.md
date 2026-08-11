# Device Install

An end-to-end physical iPhone installation example, optimized for QR-based
over-the-air installation: one ad-hoc-signed build, then a QR code pointing
at Limrun's short-lived private install page where the iPhone taps Install.

## Flow

1. **Ad-hoc signing** — on load the example checks the secret store for a
   distribution certificate and an ad-hoc provisioning profile matching the
   stored team and bundle ID. When both exist, no Apple sign-in is needed.
   Otherwise the user signs in through `@limrun/apple-auth`, picks a team,
   ensures the bundle ID, and the distribution certificate is created right
   away.
2. **Target iPhone** — registered devices are listed from the stored ad-hoc
   profiles (plus the Developer Portal when signed in). The user either
   continues with a covered device — no cable required — or registers a new
   iPhone: WebUSB is used only to read the plugged-in device's UDID (its USB
   serial number); there is no pairing. Registration creates/extends the
   ad-hoc profile and needs an Apple session.
3. **Build** — a single ad-hoc-signed build (distribution certificate +
   ad-hoc profile picked server-side by the target UDID).
4. **Install via QR** — after the build webhook, the browser exchanges the
   install ID for a token scoped to exactly the uploaded asset and creates a
   private OTA session in the registry. The QR code encodes the session's
   install page URL; the iPhone scans it, opens the page in Safari, and taps
   Install, which fires the `itms-services://` deeplink. The desktop UI polls
   the session status to show how many IPA bytes the registry has served.

## Architecture

Signing material is written through a `SigningSecretStore` backed by the
directory in the UI's "Secrets directory" field — pre-filled with the
backend's default (`backend/.secrets/`, or `SECRETS_DIR` when the backend
was started with it). When the [`publish-to-stores`](../publish-to-stores)
example ran its Connect checklist with the device-install actions selected
and both UIs point at the same directory, the stored certificates and
profiles are reused here: an iPhone already covered by those profiles
installs without another Apple sign-in. The backend then runs:

```text
lim xcode build <project> --sdk iphoneos --configuration Release \
  --certificate-p12 ... --provisioning-profile ... \
  --upload device-install-<bundle>-<id>.ipa \
  --webhook-url ... --webhook-header X-Install-Token=... --detach
```

Only the token-guarded webhook receiver on port 3001 is exposed publicly,
through the webhook URL entered in the UI. That URL is used verbatim as the
callback URL — nothing is appended — and the webhook is matched to its build
by the per-install `X-Install-Token` header alone. The local API and
signing-secret store stay on port 3000.

The browser initially receives only `device:*:install`. After a successful
build webhook, it exchanges that build's install ID for a fresh scoped token
containing `asset:<exact-uploaded-asset-id>:read`. There is no wildcard asset
grant and no asset-name-only installation path. That token authorizes
creating the OTA session in the registry; the session URLs the phone opens
carry their own one-time secret, since the phone's Safari presents no token.

## Requirements

- Node.js and Yarn 1
- The `lim` CLI on `PATH`
- `LIM_API_KEY`
- A public HTTPS URL that forwards to the webhook receiver on port 3001,
  entered in the UI's Webhook URL field. Builds run inside Limrun's cloud
  and report completion by webhook, and limbuild rejects private and
  IP-literal callback URLs — use a tool like [ngrok](https://ngrok.com)
  (`ngrok http 3001`), or [requestbin.net](https://requestbin.net) if you
  only want to inspect the payload (the wizard then never sees completion)
- An Apple Developer Program account
- A physical iPhone. It only needs to be plugged in over USB (desktop Chrome
  or Edge, secure context) when registering it for the first time; installs
  onto already-registered devices need no cable and work from any browser

## Run

```bash
export LIM_API_KEY="your api key"
yarn --cwd examples/device-install/backend install
yarn --cwd examples/device-install/frontend install
yarn --cwd examples/device-install/backend dev
```

In another terminal:

```bash
yarn --cwd examples/device-install/frontend dev
```

Open `http://localhost:5173`:

1. Enter the webhook URL in the sidebar (e.g. from `ngrok http 3001`). If
   signing material is already stored, stage 1 shows a ready summary;
   otherwise sign in with Apple, choose a team, and choose or create a
   bundle ID.
2. Pick a registered iPhone, or plug one in and register it via WebUSB.
3. Enter the project path on the backend host and start the detached build.
4. When the build webhook lands, create the QR install and scan it with the
   registered iPhone.

`backend/.secrets/` contains private keys and is gitignored. Build state is
kept in memory for this example.
