import fixture from './tunnel-protocol-v2.fixture.json';
import {
  TUNNEL_V2_CONN_ID_HEADER_BYTES,
  TUNNEL_V2_MAX_ROUTES,
  TUNNEL_V2_VERSION,
  TunnelV2ProtocolError,
  TunnelV2RouteError,
  assertTunnelV2OpenAllowed,
  assertTunnelV2Ready,
  decodeTunnelV2ServerMessage,
  encodeTunnelV2ClientMessage,
  validateTunnelV2Routes,
  type TunnelV2ClientMessage,
  type TunnelV2Route,
  type TunnelV2RouteErrorCode,
  type TunnelV2ServerMessage,
} from '../src/tunnel-v2';

describe('tunnel v2 wire contract', () => {
  test('pins protocol constants', () => {
    expect(TUNNEL_V2_VERSION).toBe(fixture.contract.version);
    expect(TUNNEL_V2_MAX_ROUTES).toBe(fixture.contract.maxRoutes);
    expect(TUNNEL_V2_CONN_ID_HEADER_BYTES).toBe(fixture.contract.connID.binaryHeaderBytes);
  });

  test('encodes every client fixture', () => {
    for (const entry of fixture.client) {
      const encoded = encodeTunnelV2ClientMessage(entry.message as TunnelV2ClientMessage);
      expect(JSON.parse(encoded)).toEqual(entry.message);
    }
  });

  test.each(fixture.contract.connID.invalidJSONValues)(
    'rejects invalid connId %p at both wire boundaries',
    (connId) => {
      expect(() =>
        encodeTunnelV2ClientMessage({
          type: 'openOk',
          connId,
        }),
      ).toThrow(TunnelV2ProtocolError);
      expect(() =>
        decodeTunnelV2ServerMessage({
          type: 'fin',
          connId,
        }),
      ).toThrow(TunnelV2ProtocolError);
    },
  );

  test('refuses to encode a non-finite connId', () => {
    expect(() =>
      encodeTunnelV2ClientMessage({
        type: 'openOk',
        connId: Number.NaN,
      }),
    ).toThrow(TunnelV2ProtocolError);
  });

  test('canonicalizes START routes while encoding', () => {
    const encoded = encodeTunnelV2ClientMessage({
      type: 'start',
      version: TUNNEL_V2_VERSION,
      routes: [{ host: 'API.Example.COM.', port: 443 }],
    });
    expect(JSON.parse(encoded)).toEqual({
      type: 'start',
      version: TUNNEL_V2_VERSION,
      routes: [{ host: 'api.example.com', port: 443 }],
    });
  });

  test('decodes every server fixture', () => {
    for (const entry of fixture.server) {
      expect(decodeTunnelV2ServerMessage(entry.message)).toEqual(entry.message);
    }
  });

  test('rejects unknown server message types', () => {
    expect(() => decodeTunnelV2ServerMessage({ type: 'future' })).toThrow(
      'unknown tunnel control message type future',
    );
  });

  test('preserves unknown diagnostic values', () => {
    expect(
      decodeTunnelV2ServerMessage({
        type: 'reset',
        connId: 1,
        reason: 'future_reason',
        osCode: 'EUNKNOWN',
      }),
    ).toEqual({
      type: 'reset',
      connId: 1,
      reason: 'future_reason',
      osCode: 'EUNKNOWN',
    });
  });
});

describe('tunnel v2 route contract', () => {
  test.each(fixture.routeCases)('canonicalizes $input.host', ({ input, canonical }) => {
    expect(validateTunnelV2Routes([input])).toEqual([canonical]);
  });

  test.each(fixture.invalidRouteSets)('rejects $name with $error', ({ routes, error }) => {
    const expected = expect.objectContaining<Partial<TunnelV2RouteError>>({
      code: error as TunnelV2RouteErrorCode,
    });
    expect(() => validateTunnelV2Routes(routes)).toThrow(expected);
    expect(() =>
      encodeTunnelV2ClientMessage({
        type: 'start',
        version: TUNNEL_V2_VERSION,
        routes,
      }),
    ).toThrow();
  });

  test('accepts exactly the declared OPEN destination', () => {
    const routes = validateTunnelV2Routes([{ host: 'LOCALHOST.', port: 8000 }]);
    const open = decodeTunnelV2ServerMessage(fixture.server.find(({ name }) => name === 'open')!.message);
    expect(open.type).toBe('open');
    expect(() =>
      assertTunnelV2OpenAllowed(open as Extract<TunnelV2ServerMessage, { type: 'open' }>, routes),
    ).not.toThrow();
  });

  test.each([
    { routeId: 'route-2', host: 'localhost', port: 8000 },
    { routeId: 'route-1', host: '127.0.0.1', port: 8000 },
    { routeId: 'route-1', host: 'localhost', port: 8001 },
  ])('rejects undeclared OPEN $routeId $host:$port', (requested) => {
    const routes: TunnelV2Route[] = [{ host: 'localhost', port: 8000 }];
    expect(() =>
      assertTunnelV2OpenAllowed(
        {
          type: 'open',
          connId: 1,
          ...requested,
          proto: 'tcp',
        },
        routes,
      ),
    ).toThrow(TunnelV2ProtocolError);
  });

  test('requires READY bindings to match the original route set', () => {
    const readyMessage = decodeTunnelV2ServerMessage(
      fixture.server.find(({ name }) => name === 'ready')!.message,
    ) as Extract<TunnelV2ServerMessage, { type: 'ready' }>;

    expect(() => assertTunnelV2Ready(readyMessage, [{ host: 'localhost', port: 8001 }])).toThrow(
      TunnelV2ProtocolError,
    );
  });
});
