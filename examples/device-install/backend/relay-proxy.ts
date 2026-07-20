// A minimal WebSocket pass-through for Limrun's registry relays. Pairing,
// device install, and the Apple relay all live on Limrun's registry and
// expect a Limrun token; the browser must never hold that token, so it
// connects here instead and the backend pipes every frame to the registry
// with the API key attached server-side. The relay protocols pass through
// untouched.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

const RELAY_PATHS = ['/ios/appstoreconnect/ws', '/ios/device/ws'];

export type RegistryRelayProxyOptions = {
  /** Limrun registry base URL, e.g. https://registry.limrun.com */
  registryUrl: string;
  /** Limrun API key attached to the upstream connection. */
  apiKey: string;
  log?: (message: string) => void;
};

export function attachRegistryRelayProxy(server: Server, options: RegistryRelayProxyOptions) {
  const log = options.log ?? (() => {});
  const registryBase = options.registryUrl.replace(/\/+$/, '');

  const relayServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!RELAY_PATHS.includes(pathname)) {
      socket.destroy();
      return;
    }
    const upstreamUrl = new URL(registryBase + pathname);
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    upstreamUrl.searchParams.set('token', options.apiKey);

    relayServer.handleUpgrade(request, socket, head, (client) => {
      log(`relay ${pathname}: browser connected, dialing registry`);
      const upstream = new WebSocket(upstreamUrl);

      // The browser sends its first frames before the upstream connection
      // finishes opening; hold those frames until it does. The binary flag
      // must travel along — the device relay is binary-framed while the
      // Apple relay is JSON text frames, and flipping either breaks the
      // browser client.
      const pending: Array<{ data: RawData; isBinary: boolean }> = [];
      upstream.on('open', () => {
        log(`relay ${pathname}: registry connection open`);
        for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
        pending.length = 0;
      });
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push({ data, isBinary });
      });
      upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }));

      client.on('close', (code, reason) => {
        log(`relay ${pathname}: browser closed (${code})${reason.length ? ` ${reason}` : ''}`);
        upstream.close();
      });
      client.on('error', (error) => {
        log(`relay ${pathname}: browser socket error: ${error.message}`);
        upstream.close();
      });
      upstream.on('close', (code, reason) => {
        log(`relay ${pathname}: registry closed (${code})${reason.length ? ` ${reason}` : ''}`);
        client.close();
      });
      upstream.on('error', (error) => {
        log(`relay ${pathname}: registry connection error: ${error.message}`);
        client.close();
      });
    });
  });
}
