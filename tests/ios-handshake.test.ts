import { createServer } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';

import { createInstanceClient } from '../src/ios-client';

type Reply = 'stall' | 'close' | 'accept' | number;

async function fixture(replies: Reply[]) {
  const server = createServer();
  const websocket = new WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  const attempts: Reply[] = [];
  const commands: string[] = [];
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const reply = replies[attempts.length] ?? 500;
    attempts.push(reply);
    if (reply === 'stall') return;
    if (typeof reply === 'number') {
      socket.end(`HTTP/1.1 ${reply} Error\r\nConnection: close\r\n\r\n`);
      return;
    }
    websocket.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data) => {
        const { type, id } = JSON.parse(data.toString());
        commands.push(type);
        if (reply === 'close') ws.terminate();
        else ws.send(JSON.stringify({ type: 'deviceInfoResult', id, udid: 'fixture' }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    attempts, commands,
    connect: (maxReconnectAttempts = 6) => createInstanceClient({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'fixture',
      logLevel: 'none', maxReconnectAttempts,
    }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      websocket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it('opens a fresh socket after a stalled upgrade and sends deviceInfo once', async () => {
  const f = await fixture(['stall', 'accept']);
  try {
    const client = await f.connect();
    client.disconnect();
    expect(f.attempts).toEqual(['stall', 'accept']);
    expect(f.commands).toEqual(['deviceInfo']);
  } finally {
    await f.close();
  }
}, 12000);

it.each([
  { replies: [503, 503], limit: 6 },
  { replies: [403], limit: 6 },
  { replies: [503], limit: 0 },
  { replies: ['close' as const], limit: 6 },
])('stops after the expected upgrades for $replies', async ({ replies, limit }) => {
  const f = await fixture(replies);
  try {
    await expect(f.connect(limit)).rejects.toThrow();
    expect(f.attempts).toEqual(replies);
    expect(f.commands).toEqual(replies[0] === 'close' ? ['deviceInfo'] : []);
  } finally {
    await f.close();
  }
});
