import IosTouchIndicators from './touch-indicators';
import {
  getIosInstanceClient,
  ensureDaemonSession,
  sendSessionCommand,
} from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({
  getIosInstanceClient: jest.fn(),
  ensureDaemonSession: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

function setup(state: string, json = false, id?: string) {
  const client = { setTouchIndicators: jest.fn().mockResolvedValue(undefined) };
  const disconnect = jest.fn();
  const target = { id: id ?? 'ios_last' };
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const command = Object.assign(Object.create(IosTouchIndicators.prototype), {
    parse: async () => ({ args: { state }, flags: { json, id } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: jest.fn().mockReturnValue(target),
    output: jest.fn(),
    outputJson: jest.fn(),
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect, target };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(ensureDaemonSession).mockResolvedValue(false);
});

test.each([
  ['on', true],
  ['off', false],
] as const)('%s updates the default instance and releases its connection', async (state, enabled) => {
  const { command, client, disconnect, target } = setup(state);
  await command.run();
  expect(command.resolveIosInstance).toHaveBeenCalledWith(undefined);
  expect(getIosInstanceClient).toHaveBeenCalledWith({}, target);
  expect(client.setTouchIndicators).toHaveBeenCalledWith(enabled);
  expect(command.output).toHaveBeenCalledWith(`Touch indicators ${enabled ? 'enabled' : 'disabled'}.`);
  expect(command.outputJson).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('explicit instance selection returns the applied state as JSON', async () => {
  const { command, target } = setup('off', true, 'ios_explicit');
  await command.run();
  expect(command.resolveIosInstance).toHaveBeenCalledWith('ios_explicit');
  expect(getIosInstanceClient).toHaveBeenCalledWith({}, target);
  expect(command.outputJson).toHaveBeenCalledWith({ enabled: false });
  expect(command.output).not.toHaveBeenCalled();
});

test('server errors propagate without a success message and still disconnect', async () => {
  const { command, client, disconnect } = setup('off', true);
  client.setTouchIndicators.mockRejectedValue(
    new Error('Touch indicators are unavailable on this simulator.'),
  );
  await expect(command.run()).rejects.toThrow('Touch indicators are unavailable');
  expect(command.output).not.toHaveBeenCalled();
  expect(command.outputJson).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test.each([
  ['on', true],
  ['off', false],
] as const)('%s reuses the session daemon', async (state, enabled) => {
  const { command, target, client, disconnect } = setup(state, true);
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  await command.run();
  expect(ensureDaemonSession).toHaveBeenCalledWith(target);
  expect(sendSessionCommand).toHaveBeenCalledWith(target.id, 'touch-indicators', [enabled]);
  expect(getIosInstanceClient).not.toHaveBeenCalled();
  expect(client.setTouchIndicators).not.toHaveBeenCalled();
  expect(disconnect).not.toHaveBeenCalled();
  expect(command.outputJson).toHaveBeenCalledWith({ enabled });
});

test('daemon errors propagate without reporting success or opening another connection', async () => {
  const { command } = setup('off', true);
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  jest.mocked(sendSessionCommand).mockRejectedValue(new Error('Touch indicators are unavailable'));
  await expect(command.run()).rejects.toThrow('Touch indicators are unavailable');
  expect(getIosInstanceClient).not.toHaveBeenCalled();
  expect(command.outputJson).not.toHaveBeenCalled();
});
