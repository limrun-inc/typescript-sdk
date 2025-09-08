import { exec } from 'child_process';
import { startTcpTunnel } from './tunnel.js';

export interface Proxy {
  address: {
    address: string;
    port: number;
  };
  close: () => void;
}

export interface Options {
  adbUrl: string;
  token: string;

  hostname?: string;
  port?: number;
  adbPath?: string;
}

/**
 * Opens a WebSocket TCP proxy for the ADB port and connects the local adb
 * client to it.
 */
export async function startAdbTunnel(options: Options): Promise<Proxy> {
  const { address, close } = await startTcpTunnel(
    options.adbUrl,
    options.token,
    options.hostname ?? '127.0.0.1',
    options.port ?? 0,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      exec(`${options.adbPath ?? 'adb'} connect ${address.address}:${address.port}`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  } catch (err) {
    close();
    throw err;
  }
  return { address, close };
}
