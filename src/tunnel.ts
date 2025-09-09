import * as net from 'net';
import { WebSocket } from 'ws';

export interface Tunnel {
  address: {
    address: string;
    port: number;
  };
  close: () => void;
}

/**
 * Starts a one-shot TCP → WebSocket proxy.
 *
 * The function creates a local TCP server that listens on an ephemeral port on
 * 127.0.0.1.  As soon as the **first** TCP client connects the server stops
 * accepting further connections and forwards all traffic between that client
 * and `remoteURL` through an authenticated WebSocket.  If you need to proxy
 * more than one TCP connection, call `startTcpTunnel` again to create a new
 * proxy instance.
 *
 * @param remoteURL Remote WebSocket endpoint (e.g. wss://example.com/instance)
 * @param token     Bearer token sent as `Authorization` header
 * @param hostname  Optional IP address to listen on. Default is 127.0.0.1
 * @param port      Optional port number to listen on. Default is to ask Node.js
 *                  to find an available non-privileged port.
 */
export async function startTcpTunnel(
  remoteURL: string,
  token: string,
  hostname: string,
  port: number,
): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    let ws: WebSocket | undefined;
    let pingInterval: NodeJS.Timeout | undefined;

    // close helper
    const close = () => {
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = undefined;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'close');
      }
      if (server.listening) {
        server.close();
      }
    };

    // No AbortController support – proxy can be closed via the returned handle

    // TCP server error
    server.once('error', (err) => {
      close();
      reject(new Error(`TCP server error: ${err.message}`));
    });

    // Listening
    server.once('listening', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        close();
        return reject(new Error('Failed to obtain listening address'));
      }
      resolve({ address, close });
    });

    // On first TCP connection
    server.on('connection', (tcpSocket) => {
      // Single-connection proxy
      server.close();

      ws = new WebSocket(remoteURL, {
        headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false,
      });

      // WebSocket error
      ws.once('error', (err: any) => {
        console.error('WebSocket error:', err);
        tcpSocket.destroy();
        close();
      });

      ws.once('open', () => {
        const socket = ws as WebSocket; // non-undefined after open

        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            (socket as any).ping();
          }
        }, 30_000);

        // TCP → WS
        tcpSocket.on('data', (chunk) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(chunk);
          }
        });

        // WS → TCP
        socket.on('message', (data: any) => {
          if (!tcpSocket.destroyed) {
            tcpSocket.write(data as Buffer);
          }
        });
      });

      // Mutual close
      tcpSocket.on('close', close);
      tcpSocket.on('error', (err: any) => {
        console.error('TCP socket error:', err);
        close();
      });

      ws.on('close', () => tcpSocket.destroy());
    });

    // Start listening
    server.listen(port, hostname);
  });
}
