import fs from 'fs';
import os from 'os';
import path from 'path';
import MacosSsh from './ssh';

function setup(flags: Record<string, unknown>, json = true) {
  let onState: (state: string) => void = () => {};
  const tunnel = {
    onConnectionStateChange: jest.fn((listener: (state: string) => void) => {
      onState = listener;
      return () => {};
    }),
    getConnectionState: jest.fn(() => 'connected'),
    close: jest.fn(),
  };
  const client = {
    enableSsh: jest.fn().mockResolvedValue({ user: 'limrun', port: 22 }),
    startPortForward: jest.fn().mockResolvedValue(tunnel),
  };
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => (ready = resolve));
  const outputJson = jest.fn(() => ready());
  const command = Object.assign(Object.create(MacosSsh.prototype), {
    parse: async () => ({ args: { port: 2222 }, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient: async () => ({ id: 'macos_test', client }),
    isJsonEnabled: () => json,
    outputJson,
    info: jest.fn(),
    output: jest.fn(),
  });
  return { command, client, tunnel, outputJson, readiness, state: (s: string) => onState(s) };
}

let dir: string;
let keyFile: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-macos-ssh-'));
  keyFile = path.join(dir, 'work.pub');
  fs.writeFileSync(keyFile, 'ssh-ed25519 AAAAC3Nz test@example\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('authorizes the key and forwards the local port to the guest sshd until stopped', async () => {
  const { command, client, tunnel, outputJson, readiness } = setup({ 'public-key': keyFile });
  const running = command.run();
  await readiness;
  expect(client.enableSsh).toHaveBeenCalledWith('ssh-ed25519 AAAAC3Nz test@example');
  expect(client.startPortForward).toHaveBeenCalledWith(2222, 22, { logLevel: 'none' });
  expect(outputJson).toHaveBeenCalledWith({
    id: 'macos_test',
    user: 'limrun',
    port: 2222,
    command: `ssh -p 2222 -i ${path.join(dir, 'work')} limrun@localhost`,
  });
  process.emit('SIGTERM');
  await running;
  expect(tunnel.close).toHaveBeenCalledTimes(1);
});

test('fails when the tunnel disconnects', async () => {
  const { command, tunnel, readiness, state } = setup({ 'public-key': keyFile });
  const running = command.run();
  await readiness;
  state('disconnected');
  await expect(running).rejects.toThrow(/SSH tunnel disconnected/);
  expect(tunnel.close).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGTERM')).toBe(0);
});

test('fails at once when the forward is already down, without printing a dead port', async () => {
  const { command, tunnel, outputJson } = setup({ 'public-key': keyFile });
  tunnel.getConnectionState.mockReturnValue('disconnected');
  await expect(command.run()).rejects.toThrow(/SSH tunnel disconnected/);
  expect(outputJson).not.toHaveBeenCalled();
  expect(tunnel.close).toHaveBeenCalledTimes(1);
});
