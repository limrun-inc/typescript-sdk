import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { sendCommand } from './daemon-client';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-daemon-client-'));
const sock = path.join(dir, 'daemon.sock');

jest.mock('./daemon', () => ({
  socketPath: () => sock,
  isDaemonRunning: () => true,
}));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a failed command keeps the instance error code and what was written', async () => {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write(
        JSON.stringify({
          type: 'stderr',
          data: 'No focused accessibility element found',
          code: 'no_focused_element',
          written: 'none',
        }) + '\n',
      );
      socket.write(JSON.stringify({ type: 'done', exitCode: 1 }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  try {
    await expect(sendCommand('ios_test', 'type', ['hello'])).rejects.toMatchObject({
      message: 'No focused accessibility element found',
      code: 'no_focused_element',
      written: 'none',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
