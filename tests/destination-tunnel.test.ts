import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import binaryFixture from './destination-tunnel-binary.fixture.json';
import fixture from './destination-tunnel-protocol.fixture.json';
import upstream from './destination-tunnel-protocol.upstream.json';
import {
  DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES,
  DESTINATION_TUNNEL_MAX_ROUTES,
  DESTINATION_TUNNEL_VERSION,
  DestinationTunnelProtocolError,
  DestinationTunnelRouteError,
  assertDestinationTunnelOpenAllowed,
  assertDestinationTunnelReady,
  decodeDestinationTunnelDataFrame,
  decodeDestinationTunnelServerMessage,
  encodeDestinationTunnelDataFrame,
  encodeDestinationTunnelClientMessage,
  validateDestinationTunnelRoutes,
  type DestinationTunnelClientMessage,
  type DestinationTunnelRoute,
  type DestinationTunnelRouteErrorCode,
  type DestinationTunnelServerMessage,
} from '../src/destination-tunnel';

describe('destination tunnel wire contract', () => {
  test('pins protocol constants', () => {
    expect(DESTINATION_TUNNEL_VERSION).toBe(fixture.contract.version);
    expect(DESTINATION_TUNNEL_MAX_ROUTES).toBe(fixture.contract.maxRoutes);
    expect(DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES).toBe(fixture.contract.connID.binaryHeaderBytes);
  });

  test.each(binaryFixture.dataFrames)('matches binary vector $name', ({ connId, payload, frame }) => {
    expect(Array.from(encodeDestinationTunnelDataFrame(connId, Buffer.from(payload)))).toEqual(frame);
    const decoded = decodeDestinationTunnelDataFrame(Buffer.from(frame));
    expect(decoded.connId).toBe(connId);
    expect(Array.from(decoded.payload)).toEqual(payload);
  });

  test.each(binaryFixture.invalidFrames)('rejects invalid binary vector $name', ({ frame }) => {
    expect(() => decodeDestinationTunnelDataFrame(Buffer.from(frame))).toThrow(
      DestinationTunnelProtocolError,
    );
  });

  test('pins vendored vectors to the canonical limrun commit', () => {
    expect(upstream).toEqual({
      repository: 'limrun-inc/limrun',
      commit: '3ccfb218a0b46af536f75052b3293292af912ee6',
      path: 'spec/destination-tunnel/v1',
      messagesSha256: 'd9f36eaaa0fe290870bc90d7d7c3914be4285174967980d6598ae957497171e4',
      binarySha256: 'e6da913a0ff85a3402f09de6cbbb18d4f9b2e76007ca48b85f4d35b66810da7d',
    });
    expect(sha256('destination-tunnel-protocol.fixture.json')).toBe(upstream.messagesSha256);
    expect(sha256('destination-tunnel-binary.fixture.json')).toBe(upstream.binarySha256);
  });

  test('encodes every client fixture', () => {
    for (const entry of fixture.client) {
      const encoded = encodeDestinationTunnelClientMessage(entry.message as DestinationTunnelClientMessage);
      expect(JSON.parse(encoded)).toEqual(entry.message);
    }
  });

  test.each(fixture.contract.connID.invalidJSONValues)(
    'rejects invalid connId %p at both wire boundaries',
    (connId) => {
      expect(() =>
        encodeDestinationTunnelClientMessage({
          type: 'openOk',
          connId,
        }),
      ).toThrow(DestinationTunnelProtocolError);
      expect(() =>
        decodeDestinationTunnelServerMessage({
          type: 'fin',
          connId,
        }),
      ).toThrow(DestinationTunnelProtocolError);
      expect(() => encodeDestinationTunnelDataFrame(connId, Buffer.from([1]))).toThrow(
        DestinationTunnelProtocolError,
      );
    },
  );

  test('refuses to encode a non-finite connId', () => {
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'openOk',
        connId: Number.NaN,
      }),
    ).toThrow(DestinationTunnelProtocolError);
  });

  test('canonicalizes START routes while encoding', () => {
    const encoded = encodeDestinationTunnelClientMessage({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      routes: [{ host: '2001:0DB8:0:0:0:0:0:1', port: 443 }],
    });
    expect(JSON.parse(encoded)).toEqual({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      routes: [{ host: '2001:db8::1', port: 443 }],
    });
  });

  test('decodes every server fixture', () => {
    for (const entry of fixture.server) {
      expect(decodeDestinationTunnelServerMessage(entry.message)).toEqual(entry.message);
    }
  });

  test('rejects unknown server message types', () => {
    expect(() => decodeDestinationTunnelServerMessage({ type: 'future' })).toThrow(
      'unknown tunnel control message type future',
    );
  });

  test('preserves unknown diagnostic values', () => {
    expect(
      decodeDestinationTunnelServerMessage({
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

function sha256(name: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(__dirname, name)))
    .digest('hex');
}

describe('destination tunnel route contract', () => {
  test.each(fixture.routeCases)('canonicalizes $input.host', ({ input, canonical }) => {
    expect(validateDestinationTunnelRoutes([input])).toEqual([canonical]);
  });

  test.each(fixture.invalidRouteSets)('rejects $name with $error', ({ routes, error }) => {
    const expected = expect.objectContaining<Partial<DestinationTunnelRouteError>>({
      code: error as DestinationTunnelRouteErrorCode,
    });
    expect(() => validateDestinationTunnelRoutes(routes)).toThrow(expected);
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'start',
        version: DESTINATION_TUNNEL_VERSION,
        routes,
      }),
    ).toThrow();
  });

  test('accepts exactly the declared OPEN destination', () => {
    const routes = validateDestinationTunnelRoutes([{ host: '10.20.30.40', port: 8000 }]);
    const open = decodeDestinationTunnelServerMessage(
      fixture.server.find(({ name }) => name === 'open')!.message,
    );
    expect(open.type).toBe('open');
    expect(() =>
      assertDestinationTunnelOpenAllowed(
        open as Extract<DestinationTunnelServerMessage, { type: 'open' }>,
        routes,
      ),
    ).not.toThrow();
  });

  test.each([
    { routeId: 'route-2', host: '10.20.30.40', port: 8000 },
    { routeId: 'route-1', host: '10.20.30.41', port: 8000 },
    { routeId: 'route-1', host: '10.20.30.40', port: 8001 },
  ])('rejects undeclared OPEN $routeId $host:$port', (requested) => {
    const routes: DestinationTunnelRoute[] = [{ host: '10.20.30.40', port: 8000 }];
    expect(() =>
      assertDestinationTunnelOpenAllowed(
        {
          type: 'open',
          connId: 1,
          ...requested,
          proto: 'tcp',
        },
        routes,
      ),
    ).toThrow(DestinationTunnelProtocolError);
  });

  test('requires READY to use the negotiated version', () => {
    const readyMessage = decodeDestinationTunnelServerMessage(
      fixture.server.find(({ name }) => name === 'ready')!.message,
    ) as Extract<DestinationTunnelServerMessage, { type: 'ready' }>;

    expect(() =>
      assertDestinationTunnelReady({ ...readyMessage, version: DESTINATION_TUNNEL_VERSION + 1 }),
    ).toThrow(DestinationTunnelProtocolError);
  });
});
