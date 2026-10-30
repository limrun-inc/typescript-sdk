import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DestinationTunnelInspectionEvent } from '@limrun/api';
import {
  runTunnelForeground,
  tunnelClientFacade,
  type TunnelClientFacade,
  type TunnelCommandIO,
} from './tunnel-command';

describe('tunnel client facade inspection wiring', () => {
  const io: TunnelCommandIO = {
    error: (message): never => {
      throw new Error(message);
    },
    output: () => {},
    info: () => {},
    outputJson: () => {},
    isJsonEnabled: () => false,
  };

  test('propagates negotiated inspection settings and callbacks', async () => {
    const startTunnel = jest.fn(async () => ({
      tunnelId: 'tunnel-1',
      close: () => {},
      getConnectionState: () => 'connected' as const,
      onConnectionStateChange: () => () => {},
    }));
    const facade = tunnelClientFacade(
      {
        startTunnel,
        getTunnelStatus: async () => ({}),
        stopTunnel: async () => {},
      },
      () => {},
      'info',
    );
    const onInspectionEvent = (_event: DestinationTunnelInspectionEvent): void => {};
    const onInspectionError = (): void => {};
    await facade.startTunnel({
      selectors: ['api.example.test'],
      inspection: {
        enabled: true,
        captureBodies: true,
        maxBodyBytes: 1024,
        persist: true,
        ttlSeconds: 3600,
      },
      onInspectionEvent,
      onInspectionError,
      resetsInactivityTimeout: false,
    });

    expect(startTunnel).toHaveBeenCalledWith({
      selectors: ['api.example.test'],
      logLevel: 'info',
      inspection: {
        enabled: true,
        captureBodies: true,
        maxBodyBytes: 1024,
        persist: true,
        ttlSeconds: 3600,
      },
      onInspectionEvent,
      onInspectionError,
      resetsInactivityTimeout: false,
    });
  });

  test('starts the foreground tunnel with the context resetsInactivityTimeout', async () => {
    const startTunnel = jest.fn(async () => {
      throw new Error('stop after start');
    });
    await expect(
      runTunnelForeground({
        product: 'ios',
        instanceId: 'instance-1',
        selectors: ['localhost:8081'],
        reconnect: false,
        inspect: false,
        harBodyLimit: 1024,
        resetsInactivityTimeout: false,
        connect: async () => ({
          startTunnel,
          getTunnelStatus: async () => ({}),
          stopTunnel: async () => {},
          disconnect: () => {},
        }),
        io,
      }),
    ).rejects.toThrow();
    expect(startTunnel).toHaveBeenCalledWith(expect.objectContaining({ resetsInactivityTimeout: false }));
  });

  test('disconnects the client when HAR setup fails', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-tunnel-command-'));
    const occupiedPath = path.join(temporary, 'file');
    fs.writeFileSync(occupiedPath, 'not a directory');
    const disconnect = jest.fn();
    const client: TunnelClientFacade = {
      startTunnel: jest.fn(async () => {
        throw new Error('must not start');
      }),
      getTunnelStatus: async () => ({}),
      stopTunnel: async () => {},
      disconnect,
    };

    try {
      await expect(
        runTunnelForeground({
          product: 'android',
          instanceId: 'instance-1',
          selectors: ['api.example.test'],
          reconnect: true,
          inspect: true,
          harBodyLimit: 1024,
          harPath: path.join(occupiedPath, 'capture.har'),
          resetsInactivityTimeout: true,
          connect: async () => client,
          io,
        }),
      ).rejects.toThrow();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(client.startTunnel).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
