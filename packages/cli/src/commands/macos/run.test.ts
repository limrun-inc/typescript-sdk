import { EventEmitter } from 'events';
import MacosRun from './run';

function fakeProcess(result: { exitCode: number }, kill = jest.fn()) {
  return Object.assign(Promise.resolve(result), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill,
  });
}

function setup(argv: string[], flags: Record<string, unknown> = {}, json = false) {
  const client = { run: jest.fn(() => fakeProcess({ exitCode: 0 })) };
  const resolveMacosClient = jest.fn(async () => ({ id: 'macos_test', client }));
  const outputJson = jest.fn();
  const command = Object.assign(Object.create(MacosRun.prototype), {
    argv,
    parse: jest.fn(async () => ({ args: {}, flags })),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveMacosClient,
    isJsonEnabled: () => json,
    outputJson,
  });
  return { command, client, resolveMacosClient, outputJson };
}

test('requires the remote command after --', async () => {
  const { command, resolveMacosClient } = setup(['sw_vers']);
  await expect(command.run()).rejects.toThrow(/Separate the remote command with --/);
  expect(resolveMacosClient).not.toHaveBeenCalled();
});

test('parses only the flags before --', async () => {
  const { command } = setup(['--id', 'macos_x', '--', 'ls', '--id']);
  await command.run();
  expect(command.parse).toHaveBeenCalledWith(MacosRun, ['--id', 'macos_x']);
});

test('runs a single argument as a shell command line', async () => {
  const { command, client } = setup(['--', 'echo $NAME | tr a-z A-Z']);
  await command.run();
  expect(client.run).toHaveBeenCalledWith('echo $NAME | tr a-z A-Z', {});
});

test('quotes each argument when given several', async () => {
  const { command, client } = setup(['--', 'printf', '%s\n', "it's"]);
  await command.run();
  expect(client.run).toHaveBeenCalledWith(`'printf' '%s\n' 'it'"'"'s'`, {});
});

test('passes the working directory, environment and timeout', async () => {
  const { command, client } = setup(['--', 'pwd'], { cwd: 'src', env: ['A=1', 'B=x=y'], timeout: 30 });
  await command.run();
  expect(client.run).toHaveBeenCalledWith('pwd', { cwd: 'src', env: ['A=1', 'B=x=y'], timeoutSeconds: 30 });
});

test('rejects a malformed --env before reaching the instance', async () => {
  const { command, resolveMacosClient } = setup(['--', 'pwd'], { env: ['NOVALUE'] });
  await expect(command.run()).rejects.toThrow(/expected KEY=VALUE/);
  expect(resolveMacosClient).not.toHaveBeenCalled();
});

test('--json collects the output and exit code', async () => {
  const { command, client, outputJson } = setup(['--', 'sw_vers'], {}, true);
  const stdout = new EventEmitter();
  const finished = new Promise<{ exitCode: number }>((resolve) =>
    setImmediate(() => {
      stdout.emit('data', 'ProductName: macOS');
      resolve({ exitCode: 0 });
    }),
  );
  client.run.mockReturnValue(
    Object.assign(finished, { stdout, stderr: new EventEmitter(), kill: jest.fn() }) as never,
  );
  await command.run();
  expect(outputJson).toHaveBeenCalledWith({ exitCode: 0, stdout: 'ProductName: macOS\n', stderr: '' });
});

test.each(['SIGINT', 'SIGTERM'] as const)('%s ends the remote command', async (signal) => {
  const { command, client } = setup(['--', 'sleep', '60']);
  let finish!: () => void;
  const kill = jest.fn(async () => finish());
  const proc = Object.assign(
    new Promise<{ exitCode: number }>((resolve) => (finish = () => resolve({ exitCode: 0 }))),
    { stdout: new EventEmitter(), stderr: new EventEmitter(), kill },
  );
  client.run.mockReturnValue(proc as never);
  const running = command.run();
  await new Promise((resolve) => setImmediate(resolve));
  process.emit(signal);
  await running;
  expect(kill).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(0);
  expect(process.listenerCount('SIGTERM')).toBe(0);
});

test('exec is another name for run', () => {
  expect(MacosRun.aliases).toContain('macos:exec');
});
