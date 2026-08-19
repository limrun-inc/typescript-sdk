import http from 'http';
import type { AddressInfo } from 'net';
import { decodeTunnelV2Status, getTunnelV2Status, stopTunnelV2 } from '../src/internal/tunnel-v2-management';

describe('tunnel v2 management', () => {
  let server: http.Server;
  let responder: (request: http.IncomingMessage, response: http.ServerResponse) => void;

  beforeEach(async () => {
    responder = (_, response) => {
      response.writeHead(500).end('missing test responder');
    };
    server = http.createServer((request, response) => responder(request, response));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('gets and validates status with bearer authentication', async () => {
    const lastDialFailure = {
      tunnelId: 'tunnel-1',
      connectionId: 0xffff_ffff,
      routeId: 'route-3',
      reason: 'connection_refused',
      osCode: 'ECONNREFUSED',
    };
    let requestMethod: string | undefined;
    let requestURL: string | undefined;
    let authorization: string | undefined;
    responder = (request, response) => {
      requestMethod = request.method;
      requestURL = request.url;
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          active: {
            tunnelId: 'tunnel-1',
            state: 'ready',
          },
          lastDialFailure,
        }),
      );
    };

    await expect(getTunnelV2Status(apiURL(), 'secret')).resolves.toEqual({
      active: {
        tunnelId: 'tunnel-1',
        state: 'ready',
      },
      lastDialFailure,
    });
    expect(requestMethod).toBe('GET');
    expect(requestURL).toBe('/v1/ios_123/api/tunnel');
    expect(authorization).toBe('Bearer secret');
  });

  test('stops by an encoded tunnel ID with bearer authentication', async () => {
    const tunnelId = 'tunnel /?&';
    let requestMethod: string | undefined;
    let requestURL: URL | undefined;
    let authorization: string | undefined;
    responder = (request, response) => {
      requestMethod = request.method;
      requestURL = new URL(request.url!, 'http://localhost');
      authorization = request.headers.authorization;
      response.writeHead(204).end();
    };

    await stopTunnelV2(apiURL(), 'secret', tunnelId);

    expect(requestMethod).toBe('DELETE');
    expect(requestURL?.pathname).toBe('/v1/ios_123/api/tunnel');
    expect(requestURL?.searchParams.get('tunnelId')).toBe(tunnelId);
    expect(authorization).toBe('Bearer secret');
  });

  test('surfaces HTTP errors', async () => {
    responder = (_, response) => {
      response.writeHead(404).end('missing');
    };

    await expect(getTunnelV2Status(apiURL(), 'secret')).rejects.toThrow(
      'getTunnelStatus failed: 404 missing',
    );
    await expect(stopTunnelV2(apiURL(), 'secret', 'tunnel-1')).rejects.toThrow(
      'stopTunnel failed: 404 missing',
    );
  });

  test.each([
    null,
    { active: null },
    { active: { tunnelId: 'one', state: 'future' } },
    { active: { tunnelId: '', state: 'ready' } },
    { lastFailure: { tunnelId: '', code: 'internal' } },
    {
      lastDialFailure: {
        tunnelId: 'one',
        connectionId: -1,
        routeId: 'route-1',
        reason: 'internal',
      },
    },
  ])('rejects malformed status %#', (status) => {
    expect(() => decodeTunnelV2Status(status)).toThrow();
  });

  test('rejects an empty stop ID before sending a request', async () => {
    let requests = 0;
    responder = (_, response) => {
      requests++;
      response.writeHead(204).end();
    };

    await expect(stopTunnelV2(apiURL(), 'secret', '   ')).rejects.toThrow('tunnelId must not be empty');
    expect(requests).toBe(0);
  });

  function apiURL(): string {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1/ios_123/api?old=value#fragment`;
  }
});
