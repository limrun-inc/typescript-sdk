import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { probePortOpen } from '../../lib/rbe-session';
import MacosSsh from './ssh';

jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }));
jest.mock('../../lib/rbe-session', () => ({ probePortOpen: jest.fn() }));

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
  const realHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = dir;
    jest.spyOn(os, 'homedir').mockReturnValue(dir);
  });
  afterEach(() => {
    process.env.HOME = realHome;
    jest.restoreAllMocks();
  });

  function child(pid: number | undefined) {
    return Object.assign(new EventEmitter(), { pid, unref: jest.fn() });
  }

  test('runs the forward in a background process and returns once it listens', async () => {
    jest.mocked(spawn).mockReturnValue(child(4242) as never);
    jest.mocked(probePortOpen).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { command, client, outputJson } = setup({ 'public-key': keyFile, detach: true, 'api-key': 'k' });
    await command.run();
    expect(client.enableSsh).toHaveBeenCalledWith('ssh-ed25519 AAAAC3Nz test@example');
    expect(client.startPortForward).not.toHaveBeenCalled();
    const [, childArgs, options] = jest.mocked(spawn).mock.calls[0]!;
    expect(childArgs.slice(1)).toEqual([
      'macos',
      'ssh',
      '2222',
      '--no-detach',
      '--id',
      'macos_test',
      '--public-key',
      keyFile,
      '--api-key',
      'k',
    ]);
    expect(options).toMatchObject({ detached: true });
    expect(outputJson).toHaveBeenCalledWith({
      id: 'macos_test',
      user: 'limrun',
      port: 2222,
      command: `ssh -p 2222 -i ${path.join(dir, 'work')} limrun@localhost`,
      pid: 4242,
      logPath: path.join(dir, '.lim', 'ssh', 'macos_test-2222.log'),
    });
  });

  test('fails with the log when the background process exits before listening', async () => {
    const proc = child(4243);
    jest.mocked(spawn).mockReturnValue(proc as never);
    jest.mocked(probePortOpen).mockImplementation(async () => {
      fs.writeFileSync(path.join(dir, '.lim', 'ssh', 'macos_test-2222.log'), 'Error: forbidden\n');
      proc.emit('exit', 1);
      return false;
    });
    const { command, outputJson } = setup({ 'public-key': keyFile, detach: true });
    await expect(command.run()).rejects.toThrow(/exited during startup \(code 1\)[\s\S]*forbidden/);
    expect(outputJson).not.toHaveBeenCalled();
  });
});
