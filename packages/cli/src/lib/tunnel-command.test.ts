import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DestinationTunnelInspectionEvent } from '@limrun/api';
import { runTunnelForeground, tunnelClientFacade, type TunnelClientFacade } from './tunnel-command';

describe('tunnel client facade inspection wiring', () => {
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
    const onInspectionGap = (): void => {};
    const onInspectionError = (): void => {};
    await facade.startTunnel({
      selectors: { domains: ['api.example.test'] },
      inspection: { enabled: true, captureBodies: true, maxBodyBytes: 1024 },
      onInspectionEvent,
      onInspectionGap,
      onInspectionError,
    });

    expect(startTunnel).toHaveBeenCalledWith({
      domains: ['api.example.test'],
      logLevel: 'info',
      inspection: { enabled: true, captureBodies: true, maxBodyBytes: 1024 },
      onInspectionEvent,
      onInspectionGap,
      onInspectionError,
    });
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
          selectors: { domains: ['api.example.test'] },
          reconnect: true,
          inspect: true,
          harPath: path.join(occupiedPath, 'capture.har'),
          connect: async () => client,
          io: {
            error: (message): never => {
              throw new Error(message);
            },
            output: () => {},
            info: () => {},
            outputJson: () => {},
            isJsonEnabled: () => false,
          },
        }),
      ).rejects.toThrow();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(client.startTunnel).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
