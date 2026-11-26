import fs from 'fs';
import os from 'os';
import path from 'path';
import { startDetached } from '../../lib/detached';
import MacosSsh from './ssh';

jest.mock('../../lib/detached', () => ({
  ...jest.requireActual('../../lib/detached'),
  startDetached: jest.fn(),
}));

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
    resolveMacosTarget: () => ({ id: 'macos_test' }),
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
  const { command, client, tunnel, outputJson, readiness } = setup({ 'public-key': keyFile, detach: false });
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
  const { command, tunnel, readiness, state } = setup({ 'public-key': keyFile, detach: false });
  const running = command.run();
  await readiness;
  state('disconnected');
  await expect(running).rejects.toThrow(/SSH tunnel disconnected/);
  expect(tunnel.close).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGTERM')).toBe(0);
});

test('fails at once when the forward is already down, without printing a dead port', async () => {
  const { command, tunnel, outputJson } = setup({ 'public-key': keyFile, detach: false });
  tunnel.getConnectionState.mockReturnValue('disconnected');
  await expect(command.run()).rejects.toThrow(/SSH tunnel disconnected/);
  expect(outputJson).not.toHaveBeenCalled();
  expect(tunnel.close).toHaveBeenCalledTimes(1);
});

describe('detached, the default', () => {
  test('runs itself with --no-detach in the background and prints the ssh command', async () => {
    jest.mocked(startDetached).mockResolvedValue({
      pid: 4242,
      logPath: '/tmp/macos-ssh.log',
      ready: { id: 'macos_test', user: 'limrun', port: 2222, command: 'ignored' },
    });
    const { command, client, outputJson } = setup({ 'public-key': keyFile, detach: true, 'api-key': 'k' });
    await command.run();
    // The background process authorizes the key and owns the forward.
    expect(client.enableSsh).not.toHaveBeenCalled();
    expect(startDetached).toHaveBeenCalledWith({
      name: 'macos-ssh-macos_test-2222',
      args: ['macos', 'ssh', '2222', '--id', 'macos_test', '--public-key', keyFile, '--api-key', 'k'],
    });
    expect(outputJson).toHaveBeenCalledWith({
      id: 'macos_test',
      user: 'limrun',
      port: 2222,
      command: `ssh -p 2222 -i ${path.join(dir, 'work')} limrun@localhost`,
      pid: 4242,
      logPath: '/tmp/macos-ssh.log',
    });
  });
});
