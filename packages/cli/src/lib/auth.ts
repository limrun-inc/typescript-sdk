import http from 'http';
import type { Socket } from 'net';
import { writeConfig, CONFIG_KEYS } from './config';

const CALLBACK_PORT = 32412;
const CALLBACK_HOST = 'localhost';
const CALLBACK_PATH = '/authn/callback';
const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface LoginOptions {
  consoleEndpoint: string;
  version: string;
  callbackHost?: string;
  callbackPort?: number;
  configWriter?: typeof writeConfig;
  opener?: (url: string) => Promise<unknown> | unknown;
  timeoutMs?: number;
}

async function openLoginUrl(url: string): Promise<void> {
  const importEsm = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<typeof import('open')>;
  const { default: open } = await importEsm('open');
  await open(url);
}

export async function login(consoleEndpoint: string, version: string): Promise<void> {
  return loginWithOptions({ consoleEndpoint, version });
}

export async function loginWithOptions(options: LoginOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const { consoleEndpoint, version } = options;
    const callbackHost = options.callbackHost ?? CALLBACK_HOST;
    const callbackPort = options.callbackPort ?? CALLBACK_PORT;
    const configWriter = options.configWriter ?? writeConfig;
    const sockets = new Set<Socket>();
    let settled = false;
    let callbackTimeout: ReturnType<typeof setTimeout> | undefined;

    const closeServer = () => {
      if (server.listening) {
        server.close();
      }
      server.closeIdleConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
    };

    const settle = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (callbackTimeout) {
        clearTimeout(callbackTimeout);
      }
      closeServer();
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    const server = http.createServer((req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
          'Access-Control-Allow-Private-Network': 'true',
          Connection: 'close',
        });
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${callbackHost}:${callbackPort}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', '*');

      const apiKey = url.searchParams.get(CONFIG_KEYS.apiKey);
      if (!apiKey) {
        res.writeHead(400, { Connection: 'close' });
        res.end('missing api-key', () => {
          settle(new Error('Login callback received without api-key'));
        });
        return;
      }

      try {
        configWriter({ [CONFIG_KEYS.apiKey]: apiKey });
      } catch (err) {
        res.writeHead(500, { Connection: 'close' });
        res.end('failed to save api-key', () => {
          settle(err instanceof Error ? err : new Error(String(err)));
        });
        return;
      }
      res.writeHead(200, { Connection: 'close' });
      res.end('OK', () => {
        settle();
      });
    });

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });

    server.listen(callbackPort, callbackHost, () => {
      const loginUrl = new URL('/authn/login', consoleEndpoint);
      loginUrl.searchParams.set('user-agent', `lim/${version}`);
      Promise.resolve((options.opener ?? openLoginUrl)(loginUrl.toString())).catch(() => {
        console.log(`Open this URL in your browser to log in:\n${loginUrl.toString()}`);
      });
    });

    callbackTimeout = setTimeout(() => {
      settle(new Error('Login timed out waiting for browser authorization. Run `lim login` again to retry.'));
    }, options.timeoutMs ?? LOGIN_CALLBACK_TIMEOUT_MS);

    server.on('error', (err) => {
      settle(new Error(`Failed to start login server on ${callbackHost}:${callbackPort}: ${err.message}`));
    });
  });
}
