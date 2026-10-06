# Remote Safari Web Inspector

This example uses the Limrun SDK to forward a running iOS simulator's Safari Web
Inspector socket to `127.0.0.1:27753` on your machine. It requires no Appium packages,
Appium server, WebDriverAgent, or local Xcode installation.

The example attaches to an existing instance, opens `https://example.com` in Safari,
discovers its inspector socket with `ios.lsof()`, and starts an authenticated
WebSocket tunnel with `startTcpTunnel()`.

## Run

Use Node.js 22.12 or later and Yarn. You need a running Limrun iOS instance and its
`status.apiUrl` and `status.token`, available in the instance create or get response.
Use the instance token, not your account API key.

```bash
git clone https://github.com/limrun-inc/typescript-sdk.git
cd typescript-sdk/examples/web-inspector-ios
yarn install --frozen-lockfile

export LIM_IOS_API_URL='https://.../api'
export LIM_IOS_TOKEN='lim_st_...'
yarn start
```

The process prints:

```text
Safari Web Inspector transport: 127.0.0.1:27753
Connect a Web Inspector protocol client to this TCP endpoint. Press Ctrl+C to stop.
```

Keep it running while your inspector client is connected. Ctrl+C or SIGTERM closes
the tunnel and SDK connection. The iOS instance keeps running; terminate it
separately when you are finished.

## Connect a client

Configure a client that supports the iOS Simulator Web Inspector protocol with
host `127.0.0.1` and port `27753`. The connection carries Apple's framed plist
protocol. The client must discover the Safari application and page, attach to the
page's target, and then send WebKit inspector commands such as `Runtime.evaluate`.

This example provides the transport only. It does not include an inspector UI or
a protocol client. The local port is not an HTTP endpoint or a Chrome DevTools
Protocol WebSocket: `curl /json/list`, Chrome DevTools, and Playwright's
`connectOverCDP()` cannot use it directly. Forwarding the socket also does not
register the remote simulator in desktop Safari's Develop menu.

The forwarding path is:

```text
Web Inspector client -> local TCP listener -> authenticated WebSocket -> simulator UNIX socket
```

`URL.searchParams` encodes the discovered socket path. `startTcpTunnel()` supplies
the instance token as a bearer header. Multiplexed mode forwards each local TCP
connection as a separate remote socket connection.

## Troubleshooting

- **Socket not found:** the example waits up to 30 seconds after opening Safari.
  Check that the instance is ready and Safari is running, then retry. The remote
  socket path is discovered on every run, so do not copy a path from another instance.
- **Port already in use:** stop the process using `27753`, or change the local port
  in `index.ts`.
- **Authentication fails:** check that the API URL and instance token belong to the
  same running iOS instance.
- **Inspector disconnects after a network interruption:** reconnect the inspector
  client after the tunnel recovers. Existing inspector sessions cannot resume their
  previous byte streams across a tunnel reconnection.
