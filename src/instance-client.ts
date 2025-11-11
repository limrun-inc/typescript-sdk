import { WebSocket, Data } from 'ws';
import { exec } from 'node:child_process';

import { startTcpTunnel } from './tunnel';
import type { Tunnel } from './tunnel';

/**
 * A client for interacting with a Limbar instance
 */
export type InstanceClient = {
  /**
   * Take a screenshot of the current screen
   * @returns A promise that resolves to the screenshot data
   */
  screenshot: () => Promise<ScreenshotData>;
  /**
   * Disconnect from the Limbar instance
   */
  disconnect: () => void;

  /**
   * Establish an ADB tunnel to the instance.
   * Returns the local TCP port and a cleanup function.
   */
  startAdbTunnel: () => Promise<Tunnel>;
  /**
   * Send an asset URL to the instance. The instance will download the asset
   * and process it (currently APK install is supported). Resolves on success,
   * rejects with an Error on failure.
   */
  sendAsset: (url: string) => Promise<void>;
};

/**
 * Controls the verbosity of logging in the client
 */
export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Configuration options for creating an Instance API client
 */
export type InstanceClientOptions = {
  /**
   * The URL of the ADB WebSocket endpoint.
   */
  adbUrl: string;
  /**
   * The URL of the main endpoint WebSocket.
   */
  endpointUrl: string;
  /**
   * The token to use for the WebSocket connections.
   */
  token: string;
  /**
   * Path to the ADB executable.
   * @default 'adb'
   */
  adbPath?: string;
  /**
   * Controls logging verbosity
   * @default 'info'
   */
  logLevel?: LogLevel;
};

type ScreenshotRequest = {
  type: 'screenshot';
  id: string;
};

type ScreenshotResponse = {
  type: 'screenshot';
  dataUri: string;
  id: string;
};

type ScreenshotData = {
  dataUri: string;
};

type ScreenshotErrorResponse = {
  type: 'screenshotError';
  message: string;
  id: string;
};

type AssetRequest = {
  type: 'asset';
  url: string;
};

type AssetResultResponse = {
  type: 'assetResult';
  result: 'success' | 'failure' | string;
  url: string;
  message?: string;
};

type ServerMessage =
  | ScreenshotResponse
  | ScreenshotErrorResponse
  | AssetResultResponse
  | { type: string; [key: string]: unknown };

/**
 * Creates a client for interacting with a Limbar instance
 * @param options Configuration options including webrtcUrl, token and log level
 * @returns An InstanceClient for controlling the instance
 */
export async function createInstanceClient(options: InstanceClientOptions): Promise<InstanceClient> {
  const serverAddress = `${options.endpointUrl}?token=${options.token}`;
  const logLevel = options.logLevel ?? 'info';
  let ws: WebSocket | undefined = undefined;

  const screenshotRequests: Map<
    string,
    {
      resolver: (value: ScreenshotData | PromiseLike<ScreenshotData>) => void;
      rejecter: (reason?: any) => void;
    }
  > = new Map();

  const assetRequests: Map<
    string,
    {
      resolver: (value: void | PromiseLike<void>) => void;
      rejecter: (reason?: any) => void;
    }
  > = new Map();

  // Logger functions
  const logger = {
    debug: (...args: any[]) => {
      if (logLevel === 'debug') console.log(...args);
    },
    info: (...args: any[]) => {
      if (logLevel === 'info' || logLevel === 'debug') console.log(...args);
    },
    warn: (...args: any[]) => {
      if (logLevel === 'warn' || logLevel === 'info' || logLevel === 'debug') console.warn(...args);
    },
    error: (...args: any[]) => {
      if (logLevel !== 'none') console.error(...args);
    },
  };

  return new Promise<InstanceClient>((resolveConnection, rejectConnection) => {
    logger.debug(`Attempting to connect to WebSocket server at ${serverAddress}...`);
    ws = new WebSocket(serverAddress);
    let pingInterval: NodeJS.Timeout | undefined;

    ws.on('message', (data: Data) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(data.toString());
      } catch (e) {
        logger.error({ data, error: e }, 'Failed to parse JSON message');
        return;
      }

      switch (message.type) {
        case 'screenshot': {
          if (!('dataUri' in message) || typeof message.dataUri !== 'string' || !('id' in message)) {
            logger.warn('Received invalid screenshot message:', message);
            break;
          }

          const screenshotMessage = message as ScreenshotResponse;
          const request = screenshotRequests.get(screenshotMessage.id);

          if (!request) {
            logger.warn(
              `Received screenshot data for unknown or already handled session: ${screenshotMessage.id}`,
            );
            break;
          }

          logger.debug(`Received screenshot data URI for session ${screenshotMessage.id}.`);
          request.resolver({ dataUri: screenshotMessage.dataUri });
          screenshotRequests.delete(screenshotMessage.id);
          break;
        }
        case 'screenshotError': {
          if (!('message' in message) || !('id' in message)) {
            logger.warn('Received invalid screenshot error message:', message);
            break;
          }

          const errorMessage = message as ScreenshotErrorResponse;
          const request = screenshotRequests.get(errorMessage.id);

          if (!request) {
            logger.warn(
              `Received screenshot error for unknown or already handled session: ${errorMessage.id}`,
            );
            break;
          }

          logger.error(
            `Server reported an error capturing screenshot for session ${errorMessage.id}:`,
            errorMessage.message,
          );
          request.rejecter(new Error(errorMessage.message));
          screenshotRequests.delete(errorMessage.id);
          break;
        }
        case 'assetResult': {
          logger.debug('Received assetResult:', message);
          const request = assetRequests.get(message.url as string);
          if (!request) {
            logger.warn(`Received assetResult for unknown or already handled url: ${message.url}`);
            break;
          }
          if (message.result === 'success') {
            logger.debug('Asset result is success');
            request.resolver();
            assetRequests.delete(message.url as string);
            break;
          }
          const errorMessage =
            typeof message.message === 'string' && message.message ?
              message.message
            : `Asset processing failed: ${JSON.stringify(message)}`;
          logger.debug('Asset result is failure', errorMessage);
          request.rejecter(new Error(errorMessage));
          assetRequests.delete(message.url as string);
          break;
        }
        default:
          logger.warn(`Received unexpected message type: ${message.type}`);
          break;
      }
    });

    ws.on('error', (err: Error) => {
      logger.error('WebSocket error:', err.message);
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        rejectConnection(err);
      }
      screenshotRequests.forEach((request) => request.rejecter(err));
    });

    ws.on('close', () => {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = undefined;
      }
      logger.debug('Disconnected from server.');
      screenshotRequests.forEach((request) => request.rejecter('Disconnected from server'));
    });

    const screenshot = async (): Promise<ScreenshotData> => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected or connection is not open.'));
      }

      const id = 'ts-client-' + Date.now();
      const screenshotRequest: ScreenshotRequest = {
        type: 'screenshot',
        id,
      };

      return new Promise<ScreenshotData>((resolve, reject) => {
        logger.debug('Sending screenshot request:', screenshotRequest);
        ws!.send(JSON.stringify(screenshotRequest), (err?: Error) => {
          if (err) {
            logger.error('Failed to send screenshot request:', err);
            reject(err);
          }
        });

        const timeout = setTimeout(() => {
          if (screenshotRequests.has(id)) {
            logger.error(`Screenshot request timed out for session ${id}`);
            screenshotRequests.get(id)?.rejecter(new Error('Screenshot request timed out'));
            screenshotRequests.delete(id);
          }
        }, 30000);
        screenshotRequests.set(id, {
          resolver: (value: ScreenshotData | PromiseLike<ScreenshotData>) => {
            clearTimeout(timeout);
            resolve(value);
            screenshotRequests.delete(id);
          },
          rejecter: (reason?: any) => {
            clearTimeout(timeout);
            reject(reason);
            screenshotRequests.delete(id);
          },
        });
      });
    };

    const disconnect = (): void => {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = undefined;
      }
      if (ws) {
        logger.debug('Closing WebSocket connection.');
        ws.close();
      }
      screenshotRequests.forEach((request) => request.rejecter('Websocket connection closed'));
    };

    /**
     * Opens a WebSocket TCP proxy for the ADB port and connects the local adb
     * client to it.
     */
    const startAdbTunnel = async (): Promise<Tunnel> => {
      const { address, close } = await startTcpTunnel(options.adbUrl, options.token, '127.0.0.1', 0);
      try {
        await new Promise<void>((resolve, reject) => {
          exec(`${options.adbPath ?? 'adb'} connect ${address.address}:${address.port}`, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
        logger.debug(`ADB connected on ${address.address}`);
      } catch (err) {
        close();
        throw err;
      }
      return { address, close };
    };

    const sendAsset = async (url: string): Promise<void> => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('WebSocket is not connected or connection is not open.'));
      }
      const assetRequest: AssetRequest = {
        type: 'asset',
        url,
      };
      ws.send(JSON.stringify(assetRequest), (err?: Error) => {
        if (err) {
          logger.error('Failed to send asset request:', err);
        }
      });
      return new Promise<void>((resolve, reject) => {
        assetRequests.set(url, { resolver: resolve, rejecter: reject });
      });
    };
    ws.on('open', () => {
      logger.debug(`Connected to ${serverAddress}`);
      
      // Set up ping interval to keep connection alive
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          (ws as any).ping();
        }
      }, 30_000);
      
      resolveConnection({
        screenshot,
        disconnect,
        startAdbTunnel,
        sendAsset,
      });
    });
  });
}
