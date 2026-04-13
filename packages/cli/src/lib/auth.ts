import http from 'http';
import open from 'open';
import { writeConfig, CONFIG_KEYS } from './config';

const CALLBACK_PORT = 32412;
const CALLBACK_PATH = '/authn/callback';

export async function login(consoleEndpoint: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', '*');

      const apiKey = url.searchParams.get(CONFIG_KEYS.apiKey);
      if (!apiKey) {
        res.writeHead(400);
        res.end('missing api-key');
        server.close();
        reject(new Error('Login callback received without api-key'));
        return;
      }

      writeConfig({ [CONFIG_KEYS.apiKey]: apiKey });
      res.writeHead(200);
      res.end('OK');

      server.close(() => {
        resolve();
      });
    });

    server.listen(CALLBACK_PORT, () => {
      const loginUrl = new URL('/authn/login', consoleEndpoint);
      loginUrl.searchParams.set('user-agent', `lim/${version}`);
      open(loginUrl.toString()).catch(() => {
        console.log(`Open this URL in your browser to log in:\n${loginUrl.toString()}`);
      });
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start login server on port ${CALLBACK_PORT}: ${err.message}`));
    });
  });
}
