import { AuthenticationError, PermissionDeniedError } from '@limrun/api';
import { BaseCommand } from './base-command';
import { login } from './lib/auth';
import { readConfig } from './lib/config';

jest.mock('./lib/auth', () => ({
  ...jest.requireActual('./lib/auth'),
  login: jest.fn(),
}));

jest.mock('./lib/config', () => ({
  ...jest.requireActual('./lib/config'),
  readConfig: jest.fn(),
}));

const loginMock = login as jest.MockedFunction<typeof login>;
const readConfigMock = readConfig as jest.MockedFunction<typeof readConfig>;

class TestCommand extends BaseCommand {
  infoLines: string[] = [];

  async run(): Promise<void> {}

  protected override info(message = ''): void {
    this.infoLines.push(message);
  }

  setFlags(flags: Record<string, unknown>): void {
    // Assign directly: setParsedFlags has session/telemetry side effects
    // irrelevant to withAuth.
    (this as unknown as { _parsedFlags: Record<string, unknown> })._parsedFlags = flags;
  }

  runWithAuth<T>(fn: () => Promise<T>): Promise<T> {
    return this.withAuth(fn);
  }
}

function makeCommand(flags: Record<string, unknown> = {}): TestCommand {
  const cmd = new TestCommand([], {} as never);
  cmd.setFlags(flags);
  return cmd;
}

function unauthenticated403(): PermissionDeniedError {
  return new PermissionDeniedError(
    403,
    { message: 'unauthenticated: no such token found' },
    undefined,
    new Headers(),
  );
}

function withTty<T>(fn: () => Promise<T>): Promise<T> {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stderr = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  const restore = () => {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stderr) Object.defineProperty(process.stderr, 'isTTY', stderr);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  };
  return fn().finally(restore);
}

describe('withAuth login handling', () => {
  beforeEach(() => {
    loginMock.mockReset();
    readConfigMock.mockReset();
    readConfigMock.mockReturnValue({
      apiKey: '',
      apiEndpoint: 'https://api.example.test',
      consoleEndpoint: 'https://console.example.test',
    });
  });

  it('guides a never-logged-in user instead of starting a login', async () => {
    const cmd = makeCommand();
    await expect(cmd.runWithAuth(() => Promise.reject(unauthenticated403()))).rejects.toThrow(
      /Not authenticated\. Run `lim login` first, or provide --api-key\./,
    );
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('re-logins and retries when a stored credential is rejected interactively', async () => {
    readConfigMock.mockReturnValue({
      apiKey: 'lim_stale_key',
      apiEndpoint: 'https://api.example.test',
      consoleEndpoint: 'https://console.example.test',
    });
    loginMock.mockResolvedValue(undefined as never);
    const cmd = makeCommand();
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new AuthenticationError(401, {}, undefined, new Headers()))
      .mockResolvedValueOnce('ok');
    await withTty(async () => {
      await expect(cmd.runWithAuth(fn)).resolves.toBe('ok');
    });
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fails with guidance instead of blocking when not interactive', async () => {
    readConfigMock.mockReturnValue({
      apiKey: 'lim_stale_key',
      apiEndpoint: 'https://api.example.test',
      consoleEndpoint: 'https://console.example.test',
    });
    // Jest runs without a TTY, matching CI and piped invocations.
    const cmd = makeCommand();
    await expect(cmd.runWithAuth(() => Promise.reject(unauthenticated403()))).rejects.toThrow(
      /Session expired\. Run `lim login` to re-authenticate\./,
    );
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('fails with guidance under --json even on a TTY', async () => {
    readConfigMock.mockReturnValue({
      apiKey: 'lim_stale_key',
      apiEndpoint: 'https://api.example.test',
      consoleEndpoint: 'https://console.example.test',
    });
    const cmd = makeCommand({ json: true });
    await withTty(async () => {
      await expect(cmd.runWithAuth(() => Promise.reject(unauthenticated403()))).rejects.toThrow(
        /Session expired\. Run `lim login` to re-authenticate\./,
      );
    });
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('rethrows genuine permission errors untouched', async () => {
    const err = new PermissionDeniedError(
      403,
      { message: 'operation is not allowed' },
      undefined,
      new Headers(),
    );
    const cmd = makeCommand();
    await expect(cmd.runWithAuth(() => Promise.reject(err))).rejects.toBe(err);
    expect(loginMock).not.toHaveBeenCalled();
  });

  it('still constructs a client without any credential (keyless instance paths)', () => {
    const cmd = makeCommand();
    const client = (cmd as unknown as { client: unknown }).client;
    expect(client).toBeDefined();
  });
});
