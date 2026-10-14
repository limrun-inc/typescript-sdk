import http from 'http';
import type { AddressInfo } from 'net';
import { addTrustedCaCertificate, postTrustedCaCertificate } from '../src/internal/trusted-ca';

describe('trusted CA certificates', () => {
  let server: http.Server;
  let responder: (request: http.IncomingMessage, body: string, response: http.ServerResponse) => void;

  beforeEach(async () => {
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => responder(request, body, response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const adbUrl = () =>
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/android_1/adbWebSocket?token=x`;

  test('posts the PEM with bearer authentication to the ADB URL', async () => {
    let seen: Record<string, string | undefined> = {};
    responder = (request, body, response) => {
      seen = { method: request.method, url: request.url, authorization: request.headers.authorization, body };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ filename: '8c1d60e6.0', sha256: 'ab' }));
    };
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    await expect(addTrustedCaCertificate(adbUrl(), 'token-1', pem)).resolves.toEqual({
      filename: '8c1d60e6.0',
      sha256: 'ab',
    });
    expect(seen).toEqual({
      method: 'POST',
      url: '/android_1/adbWebSocket/trusted-cas',
      authorization: 'Bearer token-1',
      body: pem,
    });
  });

  test('reads the reason limulator answers as JSON', async () => {
    responder = (_, __, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'the certificate is not a CA certificate' }));
    };
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/trusted-cas`;
    await expect(postTrustedCaCertificate(url, 'token-1', 'pem')).rejects.toThrow(
      'Adding the CA certificate failed (400): the certificate is not a CA certificate',
    );
  });

  test('reads the reason of a framework error and falls back to the status text', async () => {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/trusted-cas`;
    responder = (_, __, response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: true, reason: 'Not Found' }));
    };
    await expect(postTrustedCaCertificate(url, 'token-1', 'pem')).rejects.toThrow(
      'Adding the CA certificate failed (404): Not Found',
    );
    responder = (_, __, response) => {
      response.writeHead(403).end();
    };
    await expect(postTrustedCaCertificate(url, 'token-1', 'pem')).rejects.toThrow(
      'Adding the CA certificate failed (403): Forbidden',
    );
  });

  test('reports the server reason when the instance refuses', async () => {
    responder = (_, __, response) => {
      response.writeHead(501).end('this instance does not support adding CA certificates yet\n');
    };
    await expect(addTrustedCaCertificate(adbUrl(), 'token-1', 'pem')).rejects.toThrow(
      'Adding the CA certificate failed (501): this instance does not support adding CA certificates yet',
    );
  });
});
