import http from 'http';
import type { AddressInfo } from 'net';
import {
  decodeDestinationTunnelStatus,
  getDestinationTunnelStatus,
  stopDestinationTunnel,
} from '../src/internal/destination-tunnel-management';

describe('destination tunnel management', () => {
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
      selectorId: 'selector-3',
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
            selectors: [
              { id: 'selector-1', kind: 'route', value: 'localhost:3000' },
              { id: 'selector-2', kind: 'route', value: '10.20.30.40:443' },
            ],
            inspection: {
              enabled: false,
              captureBodies: false,
              maxBodyBytes: 10 * 1024 * 1024,
            },
          },
          lastDialFailure,
        }),
      );
    };

    await expect(getDestinationTunnelStatus(apiURL(), 'secret')).resolves.toEqual({
      active: {
        tunnelId: 'tunnel-1',
        state: 'ready',
        selectors: [
          { id: 'selector-1', kind: 'route', value: 'localhost:3000' },
          { id: 'selector-2', kind: 'route', value: '10.20.30.40:443' },
        ],
        inspection: {
          enabled: false,
          captureBodies: false,
          maxBodyBytes: 10 * 1024 * 1024,
        },
      },
      lastDialFailure,
    });
    expect(requestMethod).toBe('GET');
    expect(requestURL).toBe('/v1/ios_123/api/tunnel/status');
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

    await stopDestinationTunnel(apiURL(), 'secret', tunnelId);

    expect(requestMethod).toBe('DELETE');
    expect(requestURL?.pathname).toBe('/v1/ios_123/api/tunnel/tunnel%20%2F%3F%26');
    expect(requestURL?.search).toBe('');
    expect(authorization).toBe('Bearer secret');
  });

  test('surfaces HTTP errors', async () => {
    responder = (_, response) => {
      response.writeHead(404).end('missing');
    };

    await expect(getDestinationTunnelStatus(apiURL(), 'secret')).rejects.toThrow(
      'getTunnelStatus failed: 404 missing',
    );
    await expect(stopDestinationTunnel(apiURL(), 'secret', 'tunnel-1')).rejects.toThrow(
      'stopTunnel failed: 404 missing',
    );
  });

  test.each([
    null,
    { active: null },
    { active: { tunnelId: 'one', state: 'future' } },
    { active: { tunnelId: '', state: 'ready' } },
    { active: { tunnelId: 'one', state: 'ready', selectors: [{ id: '', kind: 'route', value: '' }] } },
    { lastFailure: { tunnelId: '', code: 'internal' } },
    {
      lastDialFailure: {
        tunnelId: 'one',
        connectionId: -1,
        selectorId: 'selector-1',
        reason: 'internal',
      },
    },
  ])('rejects malformed status %#', (status) => {
    expect(() => decodeDestinationTunnelStatus(status)).toThrow();
  });

  test('rejects an empty stop ID before sending a request', async () => {
    let requests = 0;
    responder = (_, response) => {
      requests++;
      response.writeHead(204).end();
    };

    await expect(stopDestinationTunnel(apiURL(), 'secret', '   ')).rejects.toThrow(
      'tunnelId must not be empty',
    );
    expect(requests).toBe(0);
  });

  function apiURL(): string {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1/ios_123/api?old=value#fragment`;
  }
});
