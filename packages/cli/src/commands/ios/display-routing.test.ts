import IosPerform from './perform';
import IosScroll from './scroll';
import IosSwipe from './swipe';
import IosRecord from './record';
import {
  ensureDaemonSession,
  getIosInstanceClient,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({
  ensureDaemonSession: jest.fn(),
  getIosInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

function setup(
  Command: typeof IosPerform | typeof IosScroll | typeof IosSwipe | typeof IosRecord,
  display?: string,
  daemon = false,
) {
  const client = {
    startRecording: jest.fn().mockResolvedValue(undefined),
    scroll: jest.fn().mockResolvedValue(undefined),
    performActions: jest.fn().mockResolvedValue({ results: [] }),
  };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  jest.mocked(ensureDaemonSession).mockResolvedValue(daemon);
  jest.mocked(sendSessionCommand).mockResolvedValue({ results: [] });
  const flags = {
    id: 'ios_test',
    display,
    action: ['type=tap,x=10,y=20'],
    amount: 300,
    from: '10,20',
    to: '10,40',
    duration: 100,
  };
  const command = Object.assign(Object.create(Command.prototype), {
    parse: async () => ({ args: { direction: 'down', action: 'start' }, flags }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    log: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect };
}

beforeEach(() => jest.clearAllMocks());

for (const Command of [IosPerform, IosScroll, IosSwipe]) {
  describe(Command.name, () => {
    test.each(['inner', 'outer'])(
      'explicit %s reaches the SDK even when a daemon exists',
      async (display) => {
        const { command, client, disconnect } = setup(Command, display, true);
        await command.run();
        const call =
          Command === IosScroll ? client.scroll.mock.calls[0] : client.performActions.mock.calls[0];
        expect(call![Command === IosScroll ? 2 : 1]).toMatchObject({ display });
        expect(sendSessionCommand).not.toHaveBeenCalled();
        expect(disconnect).toHaveBeenCalledTimes(1);
      },
    );

    test('omitted display leaves active-screen selection to the server through the daemon', async () => {
      const { command } = setup(Command, undefined, true);
      await command.run();
      expect(sendSessionCommand).toHaveBeenCalledTimes(1);
      const args = jest.mocked(sendSessionCommand).mock.calls[0]![2]!;
      expect(JSON.stringify(args)).not.toContain('display');
      expect(getIosInstanceClient).not.toHaveBeenCalled();
    });

    test('omitted display leaves active-screen selection to the server on a direct connection', async () => {
      const { command, client, disconnect } = setup(Command);
      await command.run();
      const call = Command === IosScroll ? client.scroll.mock.calls[0] : client.performActions.mock.calls[0];
      expect(call![Command === IosScroll ? 2 : 1]?.display).toBeUndefined();
      expect(disconnect).toHaveBeenCalledTimes(1);
    });
  });
}

test('swipe cleanup preserves an explicit display', async () => {
  const { command, client } = setup(IosSwipe, 'inner');
  client.performActions.mockRejectedValueOnce(new Error('gesture failed'));
  await expect(command.run()).rejects.toThrow('gesture failed');
  expect(client.performActions).toHaveBeenCalledTimes(2);
  expect(client.performActions.mock.calls[1]![1]).toMatchObject({ display: 'inner' });
});

describe('record display routing', () => {
  test.each(['inner', 'outer'])('explicit %s bypasses an older daemon', async (display) => {
    const { command, client, disconnect } = setup(IosRecord, display, true);
    await command.run();
    expect(client.startRecording).toHaveBeenCalledWith(expect.objectContaining({ display }));
    expect(sendSessionCommand).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  test('default capture uses the daemon and leaves activity selection to the server', async () => {
    const { command } = setup(IosRecord, undefined, true);
    await command.run();
    expect(sendSessionCommand).toHaveBeenCalledWith('ios_test', 'start-recording', [undefined]);
    expect(getIosInstanceClient).not.toHaveBeenCalled();
  });
});
