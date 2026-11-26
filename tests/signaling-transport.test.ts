import { WebSocketServer } from 'ws';
import { openSignalingTransport } from '../src/internal/signaling-transport';

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function withServer(
  onMessage: (ws: import('ws').WebSocket, msg: Record<string, any>) => void,
  run: (apiUrl: string) => Promise<void>,
  onConnection?: () => void,
): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/signaling' });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.on('connection', (ws) => {
    onConnection?.();
    ws.on('message', (data) => onMessage(ws, JSON.parse(data.toString())));
  });
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

test('a policy close stops reconnecting and closes the client for good', async () => {
  let connections = 0;
  await withServer(
    (ws) => {
      ws.send(
        JSON.stringify({ type: 'error', message: 'this token grants watch only; the session is closed' }),
      );
      ws.close(1008);
    },
    async (apiUrl) => {
      let closed = 0;
      const transport = await openSignalingTransport({
        apiUrl,
        token: 't',
        logger: quiet,
        reconnectDelay: 10,
        onClosed: () => closed++,
      });
      try {
        await expect(transport.request('tap', { x: 1, y: 2 })).rejects.toThrow(
          'Connection closed: this token grants watch only; the session is closed',
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(transport.getConnectionState()).toBe('disconnected');
        expect(closed).toBe(1);
      } finally {
        transport.disconnect();
      }
    },
    () => connections++,
  );
  expect(connections).toBe(1);
});

test('a 1008 close without an error frame does not reconnect either', async () => {
  let connections = 0;
  await withServer(
    (ws) => ws.close(1008),
    async (apiUrl) => {
      const transport = await openSignalingTransport({
        apiUrl,
        token: 't',
        logger: quiet,
        reconnectDelay: 10,
      });
      try {
        await expect(transport.request('tap')).rejects.toThrow(
          'Connection closed: the instance closed the session',
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        transport.disconnect();
      }
    },
    () => connections++,
  );
  expect(connections).toBe(1);
});

test('a session refused while the client prepares rejects with the instance message', async () => {
  await withServer(
    (ws) => {
      ws.send(
        JSON.stringify({ type: 'error', message: 'this token grants watch only; the session is closed' }),
      );
      ws.close(1008);
    },
    async (apiUrl) => {
      await expect(
        openSignalingTransport({
          apiUrl,
          token: 't',
          logger: quiet,
          onFirstOpen: (t) => t.request('deviceInfo'),
        }),
      ).rejects.toThrow('this token grants watch only; the session is closed');
    },
  );
});

test('request ids are random UUIDs', async () => {
  const ids: string[] = [];
  await withServer(
    (ws, msg) => {
      ids.push(msg['id']);
      ws.send(JSON.stringify({ type: 'okResult', id: msg['id'] }));
    },
    async (apiUrl) => {
      const transport = await openSignalingTransport({ apiUrl, token: 't', logger: quiet });
      try {
        await transport.request('ok');
        await transport.request('ok');
      } finally {
        transport.disconnect();
      }
    },
  );
  expect(ids).toHaveLength(2);
  for (const id of ids)
    expect(id).toMatch(/^ts-client-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ids[0]).not.toBe(ids[1]);
});
