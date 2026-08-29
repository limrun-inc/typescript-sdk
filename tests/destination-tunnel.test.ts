import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import binaryFixture from './destination-tunnel-binary.fixture.json';
import fixture from './destination-tunnel-protocol.fixture.json';
import upstream from './destination-tunnel-protocol.upstream.json';
import {
  DESTINATION_TUNNEL_CONN_ID_HEADER_BYTES,
  DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_DEFAULT_WINDOW,
  DESTINATION_TUNNEL_FAKE_RANGE,
  DESTINATION_TUNNEL_MAX_DOMAINS,
  DESTINATION_TUNNEL_MAX_ROUTES,
  DESTINATION_TUNNEL_MAX_BODY_BYTES,
  DESTINATION_TUNNEL_MAX_WINDOW,
  DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT,
  DESTINATION_TUNNEL_VERSION,
  DestinationTunnelProtocolError,
  DestinationTunnelSelectorError,
  assertDestinationTunnelOpenAllowed,
  assertDestinationTunnelReady,
  decodeDestinationTunnelDataFrame,
  decodeDestinationTunnelServerMessage,
  destinationTunnelConfigHash,
  disabledDestinationTunnelInspection,
  destinationTunnelDomainMatches,
  destinationTunnelSelectorIds,
  encodeDestinationTunnelDataFrame,
  encodeDestinationTunnelClientMessage,
  normalizeDestinationTunnelInspection,
  validateDestinationTunnelDomains,
  validateDestinationTunnelRoutes,
  validateDestinationTunnelSelectors,
  type DestinationTunnelClientMessage,
  type DestinationTunnelSelectorErrorCode,
  type DestinationTunnelSelectors,
  type DestinationTunnelServerMessage,
} from '../src/destination-tunnel';

describe('destination tunnel wire contract', () => {
  test('pins protocol constants', () => {
    expect(DESTINATION_TUNNEL_VERSION).toBe(fixture.contract.version);
    expect(DESTINATION_TUNNEL_MAX_ROUTES).toBe(fixture.contract.maxRoutes);
    expect(DESTINATION_TUNNEL_MAX_DOMAINS).toBe(fixture.contract.maxDomains);
    expect(DESTINATION_TUNNEL_FAKE_RANGE).toBe(fixture.contract.fakeRange);
    expect(DESTINATION_TUNNEL_MAX_WINDOW).toBe(fixture.contract.maxWindow);
    expect(DESTINATION_TUNNEL_DEFAULT_WINDOW).toBe(fixture.contract.defaultWindow);
    expect(DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT).toBe(fixture.contract.maxWindowIncrement);
    expect(DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES).toBe(fixture.contract.defaultMaxBodyBytes);
    expect(DESTINATION_TUNNEL_MAX_BODY_BYTES).toBe(fixture.contract.maxBodyBytes);
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
      commit: '6ae191c433210631a382558c8d37ddfed5705766',
      path: 'design/destination-tunnel/v1',
      messagesSha256: '8f74232654b4657c9ecd673d7ee3d9b132ec9e74cf7d01fd9b4ae955f234857d',
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
          transport: { type: 'tcp' },
          window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
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
        transport: { type: 'tcp' },
        window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
      }),
    ).toThrow(DestinationTunnelProtocolError);
  });

  test('canonicalizes START selectors while encoding', () => {
    const encoded = encodeDestinationTunnelClientMessage({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      selectors: ['[2001:0DB8:0:0:0:0:0:1]:443'],
      inspection: disabledDestinationTunnelInspection(),
      window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
    });
    expect(JSON.parse(encoded)).toEqual({
      type: 'start',
      version: DESTINATION_TUNNEL_VERSION,
      selectors: ['[2001:db8::1]:443'],
      inspection: disabledDestinationTunnelInspection(),
      window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
    });
  });

  test('decodes every server fixture', () => {
    for (const entry of fixture.server) {
      expect(decodeDestinationTunnelServerMessage(entry.message)).toEqual(entry.message);
    }
  });

  test.each(fixture.unknownFieldCases)('$name', ({ direction, input, decoded }) => {
    if (direction === 'client') {
      expect(
        JSON.parse(encodeDestinationTunnelClientMessage(input as DestinationTunnelClientMessage)),
      ).toEqual(decoded);
      return;
    }
    expect(decodeDestinationTunnelServerMessage(input)).toEqual(decoded);
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

  test('defaults and validates inspection body capture limits', () => {
    expect(normalizeDestinationTunnelInspection({ enabled: true, captureBodies: false })).toEqual({
      enabled: true,
      captureBodies: false,
      maxBodyBytes: DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
    });
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'start',
        version: DESTINATION_TUNNEL_VERSION,
        selectors: ['localhost:8080'],
        inspection: {
          enabled: false,
          captureBodies: true,
          maxBodyBytes: DESTINATION_TUNNEL_DEFAULT_MAX_BODY_BYTES,
        },
        window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
      }),
    ).toThrow('captureBodies requires inspection to be enabled');
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'start',
        version: DESTINATION_TUNNEL_VERSION,
        selectors: ['localhost:8080'],
        inspection: {
          enabled: true,
          captureBodies: true,
          maxBodyBytes: DESTINATION_TUNNEL_MAX_BODY_BYTES + 1,
        },
        window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
      }),
    ).toThrow(`maxBodyBytes must be an integer between 1 and ${DESTINATION_TUNNEL_MAX_BODY_BYTES}`);
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
    const expected = expect.objectContaining<Partial<DestinationTunnelSelectorError>>({
      code: error as DestinationTunnelSelectorErrorCode,
    });
    expect(() => validateDestinationTunnelRoutes(routes)).toThrow(expected);
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'start',
        version: DESTINATION_TUNNEL_VERSION,
        selectors: routes.map(
          ({ host, port }) => `${host.includes(':') ? `[${host}]` : host}:${port}`,
        ),
        inspection: disabledDestinationTunnelInspection(),
        window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
      }),
    ).toThrow();
  });

  test('accepts exactly the declared OPEN destination', () => {
    const selectors = validateDestinationTunnelSelectors(['10.20.30.40:8000']);
    const open = decodeDestinationTunnelServerMessage(
      fixture.server.find(({ name }) => name === 'open')!.message,
    );
    expect(open.type).toBe('open');
    expect(() =>
      assertDestinationTunnelOpenAllowed(
        open as Extract<DestinationTunnelServerMessage, { type: 'open' }>,
        selectors,
      ),
    ).not.toThrow();
  });

  test.each([
    { selectorId: 'selector-2', host: '10.20.30.40', port: 8000 },
    { selectorId: 'selector-1', host: '10.20.30.41', port: 8000 },
    { selectorId: 'selector-1', host: '10.20.30.40', port: 8001 },
  ])('rejects undeclared OPEN $selectorId $host:$port', (requested) => {
    const selectors = ['10.20.30.40:8000'];
    expect(() =>
      assertDestinationTunnelOpenAllowed(
        {
          type: 'open',
          connId: 1,
          ...requested,
          transport: { type: 'tcp' },
          window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
        },
        selectors,
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

describe('destination tunnel selector contract', () => {
  test.each(fixture.domainCases)('canonicalizes domain $input', ({ input, canonical }) => {
    expect(validateDestinationTunnelDomains([input])).toEqual([canonical]);
  });

  test.each(fixture.invalidDomainSets)('rejects domain set $name with $error', ({ domains, error }) => {
    expect(() => validateDestinationTunnelDomains(domains)).toThrow(
      expect.objectContaining<Partial<DestinationTunnelSelectorError>>({
        code: error as DestinationTunnelSelectorErrorCode,
      }),
    );
  });

  test.each(fixture.domainMatchCases)(
    'matches $pattern against $host: $matches',
    ({ pattern, host, matches }) => {
      expect(destinationTunnelDomainMatches(pattern, host)).toBe(matches);
    },
  );

  test('requires at least one selector of any kind', () => {
    expect(() => validateDestinationTunnelSelectors([])).toThrow(
      expect.objectContaining<Partial<DestinationTunnelSelectorError>>({ code: 'empty' }),
    );
  });

  test('applies the Android minimum route port policy when requested', () => {
    expect(() =>
      validateDestinationTunnelSelectors(
        ['localhost:80'],
        { minRoutePort: 1024 },
      ),
    ).toThrow(expect.objectContaining<Partial<DestinationTunnelSelectorError>>({ code: 'invalid_port' }));
    expect(
      validateDestinationTunnelSelectors(
        ['localhost:8080'],
        { minRoutePort: 1024 },
      ),
    ).toEqual(['localhost:8080']);
  });

  test('assigns ordered 1-based selector IDs', () => {
    expect(
      destinationTunnelSelectorIds(['localhost:8080', '*.corp.example', 'db.internal']),
    ).toEqual(['selector-1', 'selector-2', 'selector-3']);
  });

  test.each(fixture.configHashCases)('pins config hash for $name', ({ selectors, inspection, sha256 }) => {
    expect(destinationTunnelConfigHash(selectors as DestinationTunnelSelectors, inspection)).toBe(sha256);
  });

  test.each(fixture.openAllowedCases)(
    'authorizes OPEN case $name: $allowed',
    ({ selectors, open, allowed }) => {
      const message = {
        type: 'open' as const,
        connId: 1,
        transport: { type: 'tcp' as const },
        window: DESTINATION_TUNNEL_DEFAULT_WINDOW,
        ...open,
      };
      const selectorSet = validateDestinationTunnelSelectors(selectors as DestinationTunnelSelectors);
      if (allowed) {
        expect(() => assertDestinationTunnelOpenAllowed(message, selectorSet)).not.toThrow();
      } else {
        expect(() => assertDestinationTunnelOpenAllowed(message, selectorSet)).toThrow(
          DestinationTunnelProtocolError,
        );
      }
    },
  );

  test('round-trips windowUpdate messages in both directions', () => {
    const encoded = encodeDestinationTunnelClientMessage({
      type: 'windowUpdate',
      connId: 5,
      increment: 65536,
    });
    expect(JSON.parse(encoded)).toEqual({ type: 'windowUpdate', connId: 5, increment: 65536 });
    expect(
      decodeDestinationTunnelServerMessage({ type: 'windowUpdate', connId: 5, increment: 65536 }),
    ).toEqual({ type: 'windowUpdate', connId: 5, increment: 65536 });
  });

  test.each([0, -1, 1.5, DESTINATION_TUNNEL_MAX_WINDOW_INCREMENT + 1])(
    'rejects invalid windowUpdate increment %p',
    (increment) => {
      expect(() =>
        encodeDestinationTunnelClientMessage({ type: 'windowUpdate', connId: 5, increment }),
      ).toThrow(DestinationTunnelProtocolError);
      expect(() =>
        decodeDestinationTunnelServerMessage({ type: 'windowUpdate', connId: 5, increment }),
      ).toThrow(DestinationTunnelProtocolError);
    },
  );

  test.each([0, -5, 1.5, DESTINATION_TUNNEL_MAX_WINDOW + 1])('rejects invalid window %p', (window) => {
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'openOk',
        connId: 5,
        transport: { type: 'tcp' },
        window,
      }),
    ).toThrow(DestinationTunnelProtocolError);
    expect(() =>
      decodeDestinationTunnelServerMessage({
        type: 'open',
        connId: 5,
        selectorId: 'selector-1',
        host: 'localhost',
        port: 8080,
        transport: { type: 'tcp' },
        window,
      }),
    ).toThrow(DestinationTunnelProtocolError);
  });

  test('requires windows in START, OPEN, and OPEN-OK and configHash in READY', () => {
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'start',
        version: 1,
        selectors: ['localhost:8080'],
        inspection: disabledDestinationTunnelInspection(),
      } as DestinationTunnelClientMessage),
    ).toThrow('window must be an integer');
    expect(() =>
      encodeDestinationTunnelClientMessage({
        type: 'openOk',
        connId: 1,
        transport: { type: 'tcp' },
      } as DestinationTunnelClientMessage),
    ).toThrow('window must be an integer');
    expect(() =>
      decodeDestinationTunnelServerMessage({
        type: 'open',
        connId: 1,
        selectorId: 'selector-1',
        host: 'localhost',
        port: 8080,
        transport: { type: 'tcp' },
      }),
    ).toThrow('window must be an integer');
    expect(() =>
      decodeDestinationTunnelServerMessage({
        type: 'ready',
        version: 1,
        tunnelId: 'tunnel-1',
        selectors: [],
      }),
    ).toThrow('configHash must be a string');
  });

  test('rejects malformed selector reports in ready', () => {
    expect(() =>
      decodeDestinationTunnelServerMessage({
        type: 'ready',
        version: 1,
        tunnelId: 'tunnel-1',
        selectors: [{ id: 'other-1', kind: 'domain', value: 'x' }],
        configHash: 'hash',
      }),
    ).toThrow(DestinationTunnelProtocolError);
    expect(() =>
      decodeDestinationTunnelServerMessage({
        type: 'ready',
        version: 1,
        tunnelId: 'tunnel-1',
        selectors: [{ id: 'selector-0', kind: 'route', value: 'localhost:1' }],
        configHash: 'hash',
      }),
    ).toThrow(DestinationTunnelProtocolError);
    expect(() =>
      decodeDestinationTunnelServerMessage({
        type: 'ready',
        version: 1,
        tunnelId: 'tunnel-1',
        selectors: [
          { id: 'selector-1', kind: 'route', value: 'localhost:1', binds: [{ address: 'x', status: 'nope' }] },
        ],
        configHash: 'hash',
      }),
    ).toThrow(DestinationTunnelProtocolError);
  });
});
