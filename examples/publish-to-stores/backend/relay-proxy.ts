// A minimal WebSocket pass-through for Limrun's Apple relay. The relay
// lives on Limrun's registry edge and expects a Limrun token; the browser
// must never hold that token, so it connects here instead and the backend
// pipes every frame to the registry with the API key attached server-side.
// The relay protocol itself (JSON text frames) passes through untouched.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';

export const APPLE_RELAY_PATH = '/ios/appstoreconnect/ws';

export type AppleRelayProxyOptions = {
  /** Limrun registry base URL, e.g. https://registry.limrun.com */
  registryUrl: string;
  /** Limrun API key attached to the upstream connection. */
  apiKey: string;
  log?: (message: string) => void;
};

export function attachAppleRelayProxy(server: Server, options: AppleRelayProxyOptions) {
  const log = options.log ?? (() => {});
  const upstreamUrl = new URL(options.registryUrl.replace(/\/+$/, '') + APPLE_RELAY_PATH);
  upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  upstreamUrl.searchParams.set('token', options.apiKey);

  const relayServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== APPLE_RELAY_PATH) {
      socket.destroy();
      return;
    }
    relayServer.handleUpgrade(request, socket, head, (client) => {
      log('apple relay: browser connected, dialing registry');
      const upstream = new WebSocket(upstreamUrl);

      // The browser sends its first request before the upstream connection
      // finishes opening; hold those frames until it does. The binary flag
      // must travel along — the relay protocol is JSON text frames, and a
      // text frame turned binary breaks the browser client.
      const pending: Array<{ data: RawData; isBinary: boolean }> = [];
      upstream.on('open', () => {
        log('apple relay: registry connection open');
        for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
        pending.length = 0;
      });
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else pending.push({ data, isBinary });
      });
      upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }));

      client.on('close', (code, reason) => {
        log(`apple relay: browser closed (${code})${reason.length ? ` ${reason}` : ''}`);
        upstream.close();
      });
      client.on('error', (error) => {
        log(`apple relay: browser socket error: ${error.message}`);
        upstream.close();
      });
      upstream.on('close', (code, reason) => {
        log(`apple relay: registry closed (${code})${reason.length ? ` ${reason}` : ''}`);
        client.close();
      });
      upstream.on('error', (error) => {
        log(`apple relay: registry connection error: ${error.message}`);
        client.close();
      });
    });
  });
}
