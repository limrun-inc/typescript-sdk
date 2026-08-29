import type { Agent as HttpAgent } from 'http';
import net from 'net';
import tls from 'tls';

import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { EnvHttpProxyAgent } from 'undici';

import type { Fetch } from './builtin-types';

// For requests whose server responds only after finishing long work (no bytes
// until then). Matches the ingress proxy-read-timeout so the client is never
// the first to give up. undici's defaults are 300s, which would abort e.g. an
// instance-side artifact upload that takes longer.
const longRequestTimeouts = { headersTimeout: 3_600_000, bodyTimeout: 3_600_000 };
const maxConnectResponseHeaderBytes = 64 * 1024;

export interface TcpConnectOptions {
  /** Host actually sent to connect(2), or in the CONNECT authority. */
  host: string;
  port: number;
  /**
   * Original destination used only for HTTP_PROXY/HTTPS_PROXY/NO_PROXY
   * selection. This may differ from host when the caller resolved a domain
   * locally before dialing it.
   */
  proxyLookupHost?: string;
  proxyLookupProtocol: 'http:' | 'https:';
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TcpConnectResult {
  socket: net.Socket;
  connectMs: number;
  /** Address of the destination, never the address of an HTTP proxy. */
  remoteAddress?: string;
}

class NodeProxyTransport {
  private envHttpProxyAgent: EnvHttpProxyAgent | undefined;
  private longRequestDispatcher: EnvHttpProxyAgent | undefined;
  private websocketAgents = new Map<string, HttpAgent>();

  fetch: Fetch = async (input, init) => {
    if (!this.hasProxyEnv()) {
      return fetch(input, init);
    }

    return (fetch as any)(input, {
      ...(init ?? {}),
      dispatcher: this.getEnvHttpProxyAgent(),
    });
  };

  /**
   * fetch for requests that legitimately receive no response bytes for many
   * minutes (the server answers only after completing long work). Plain fetch
   * would abort them at undici's default 300s headersTimeout.
   * EnvHttpProxyAgent covers the no-proxy case too: it routes non-proxied
   * origins through an internal Agent built with these same options.
   */
  fetchLongRequest: Fetch = async (input, init) => {
    this.longRequestDispatcher ??= new EnvHttpProxyAgent(longRequestTimeouts);
    return (fetch as any)(input, {
      ...(init ?? {}),
      dispatcher: this.longRequestDispatcher,
    });
  };

  getWebSocketAgent(url: string): HttpAgent | undefined {
    if (!this.hasProxyEnv()) {
      return undefined;
    }

    const proxyUrl = getProxyForUrl(this.getWebSocketProxyLookupUrl(url));
    if (!proxyUrl) {
      return undefined;
    }

    let agent = this.websocketAgents.get(proxyUrl);
    if (!agent) {
      const createdAgent = new HttpsProxyAgent(proxyUrl);
      this.websocketAgents.set(proxyUrl, createdAgent);
      agent = createdAgent;
    }

    return agent;
  }

  /**
   * Opens a paused TCP stream to a destination, tunneling through the proxy
   * selected by proxy-from-env when applicable. The caller owns the returned
   * socket and must resume it after installing data/end/error handlers.
   */
  connectTcp(options: TcpConnectOptions): Promise<TcpConnectResult> {
    const lookupHost = options.proxyLookupHost ?? options.host;
    const lookupUrl = `${options.proxyLookupProtocol}//${formatAuthority(lookupHost, options.port)}`;
    const proxyUrl = getProxyForUrl(lookupUrl);
    if (!proxyUrl) {
      return connectDirect(options);
    }
    return connectThroughProxy(proxyUrl, options);
  }

  private getEnvHttpProxyAgent(): EnvHttpProxyAgent {
    this.envHttpProxyAgent ??= new EnvHttpProxyAgent();
    return this.envHttpProxyAgent;
  }

  private hasProxyEnv(): boolean {
    if (typeof process === 'undefined' || !process.versions?.node) {
      return false;
    }

    const env = process.env;
    return !!(env['http_proxy'] || env['HTTP_PROXY'] || env['https_proxy'] || env['HTTPS_PROXY']);
  }

  private getWebSocketProxyLookupUrl(url: string): string {
    const lookupUrl = new URL(url);
    if (lookupUrl.protocol === 'ws:') {
      lookupUrl.protocol = 'http:';
    } else if (lookupUrl.protocol === 'wss:') {
      lookupUrl.protocol = 'https:';
    }
    return lookupUrl.toString();
  }
}

export const nodeProxyTransport = new NodeProxyTransport();

function connectDirect(options: TcpConnectOptions): Promise<TcpConnectResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({
      host: options.host,
      port: options.port,
      allowHalfOpen: true,
    });
    const timer = setTimeout(() => {
      fail(codedError(`connection to ${formatAuthority(options.host, options.port)} timed out`, 'ETIMEDOUT'));
    }, options.timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', fail);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(codedError('TCP connection cancelled', 'ECANCELED'));
    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      socket.pause();
      cleanup();
      resolve({
        socket,
        connectMs: Date.now() - startedAt,
        ...(socket.remoteAddress === undefined ? {} : { remoteAddress: socket.remoteAddress }),
      });
    };

    socket.once('connect', onConnect);
    socket.once('error', fail);
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function connectThroughProxy(proxyUrlString: string, options: TcpConnectOptions): Promise<TcpConnectResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = Buffer.alloc(0);
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(proxyUrlString);
    } catch {
      reject(codedError(`invalid proxy URL: ${proxyUrlString}`, 'EPROXY'));
      return;
    }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      reject(codedError(`unsupported proxy protocol ${proxyUrl.protocol}`, 'EPROXY'));
      return;
    }

    const proxyPort =
      proxyUrl.port ? Number(proxyUrl.port)
      : proxyUrl.protocol === 'https:' ? 443
      : 80;
    const proxyHost = unbracketHost(proxyUrl.hostname);
    const socket =
      proxyUrl.protocol === 'https:' ?
        tls.connect({
          host: proxyHost,
          port: proxyPort,
          rejectUnauthorized: true,
          ...(net.isIP(proxyHost) ? {} : { servername: proxyHost }),
          ALPNProtocols: ['http/1.1'],
        })
      : net.createConnection({
          host: proxyHost,
          port: proxyPort,
          allowHalfOpen: true,
        });
    socket.allowHalfOpen = true;
    const connectedEvent = proxyUrl.protocol === 'https:' ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      fail(
        codedError(
          `proxy connection to ${formatAuthority(options.host, options.port)} timed out`,
          'ETIMEDOUT',
        ),
      );
    }, options.timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeListener(connectedEvent, onProxyConnected);
      socket.removeListener('data', onData);
      socket.removeListener('end', onUnexpectedClose);
      socket.removeListener('close', onUnexpectedClose);
      socket.removeListener('error', fail);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => fail(codedError('proxy connection cancelled', 'ECANCELED'));
    const onUnexpectedClose = (): void =>
      fail(codedError('proxy closed before completing CONNECT', 'ECONNRESET'));
    const onProxyConnected = (): void => {
      const authority = formatAuthority(options.host, options.port);
      const headers = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, 'Proxy-Connection: Keep-Alive'];
      if (proxyUrl.username || proxyUrl.password) {
        const username = decodeUrlCredential(proxyUrl.username);
        const password = decodeUrlCredential(proxyUrl.password);
        headers.push(
          `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
        );
      }
      socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    };
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const headerEnd = response.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (response.length > maxConnectResponseHeaderBytes) {
          fail(codedError('proxy CONNECT response headers exceeded 65536 bytes', 'EPROXY'));
        }
        return;
      }
      if (headerEnd + 4 > maxConnectResponseHeaderBytes) {
        fail(codedError('proxy CONNECT response headers exceeded 65536 bytes', 'EPROXY'));
        return;
      }

      const statusLineEnd = response.indexOf('\r\n');
      const statusLine = response
        .subarray(0, statusLineEnd < 0 ? headerEnd : statusLineEnd)
        .toString('latin1');
      const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(statusLine);
      if (!statusMatch) {
        fail(codedError(`invalid proxy CONNECT response: ${statusLine}`, 'EPROXY'));
        return;
      }
      const statusCode = Number(statusMatch[1]);
      if (statusCode < 200 || statusCode >= 300) {
        fail(
          codedError(
            `proxy CONNECT failed with status ${statusCode}`,
            statusCode === 407 ? 'EPROXYAUTH' : 'EPROXYCONNECT',
          ),
        );
        return;
      }

      settled = true;
      socket.pause();
      cleanup();
      const remainder = response.subarray(headerEnd + 4);
      if (remainder.length > 0) socket.unshift(remainder);
      resolve({
        socket,
        connectMs: Date.now() - startedAt,
        remoteAddress: options.host,
      });
    };

    socket.once(connectedEvent, onProxyConnected);
    socket.on('data', onData);
    socket.once('end', onUnexpectedClose);
    socket.once('close', onUnexpectedClose);
    socket.once('error', fail);
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function formatAuthority(host: string, port: number): string {
  return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function unbracketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}
