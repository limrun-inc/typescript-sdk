import { WebSocketServer } from 'ws';
import { openSignalingTransport } from '../src/internal/signaling-transport';

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function withServer(
  onMessage: (ws: import('ws').WebSocket, msg: Record<string, any>) => void,
  run: (apiUrl: string) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/signaling' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (ws) => ws.on('message', (data) => onMessage(ws, JSON.parse(data.toString()))));
  try {
    await run(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('matches replies to requests by id and turns them into results', async () => {
  await withServer(
    (ws, msg) => {
      // Answer out of order: the later request first.
      if (msg['type'] === 'slow')
        setTimeout(() => ws.send(JSON.stringify({ type: 'slowResult', id: msg['id'], n: 1 })), 20);
      else ws.send(JSON.stringify({ type: 'fastResult', id: msg['id'], n: 2 }));
    },
    async (apiUrl) => {
      const transport = await openSignalingTransport({
        apiUrl,
        token: 't',
        logger: quiet,
        responseHandlers: { slowResult: (m) => m['n'], fastResult: (m) => m['n'] },
      });
      try {
        expect(await Promise.all([transport.request('slow'), transport.request('fast')])).toEqual([1, 2]);
      } finally {
        transport.disconnect();
      }
    },
  );
});

test('fails pending requests with the reason the instance gave before closing', async () => {
  await withServer(
    (ws) => {
      ws.send(JSON.stringify({ type: 'error', message: 'launchApp needs the all grant' }));
      ws.close(1008);
    },
    async (apiUrl) => {
      const transport = await openSignalingTransport({
        apiUrl,
        token: 't',
        logger: quiet,
        maxReconnectAttempts: 0,
      });
      try {
        await expect(transport.request('launchApp', { bundleId: 'x' })).rejects.toThrow(
          'Connection closed: launchApp needs the all grant',
        );
      } finally {
        transport.disconnect();
      }
    },
  );
});

test('waits without a timeout when asked, and reports messages sent before the reply', async () => {
  const progress: unknown[] = [];
  await withServer(
    (ws, msg) => {
      ws.send(
        JSON.stringify({ type: 'restoreSnapshotProgress', id: msg['id'], progress: { phase: 'resolving' } }),
      );
      setTimeout(() => ws.send(JSON.stringify({ type: 'restoreSnapshotResult', id: msg['id'] })), 20);
    },
    async (apiUrl) => {
      const transport = await openSignalingTransport({
        apiUrl,
        token: 't',
        logger: quiet,
        handleMessage: (m) => m.type === 'restoreSnapshotProgress' && (progress.push(m['progress']), true),
      });
      try {
        const id = transport.nextId();
        await transport.request('restoreSnapshot', {}, () => 'done', 0, id);
        expect(progress).toEqual([{ phase: 'resolving' }]);
      } finally {
        transport.disconnect();
      }
    },
  );
});
