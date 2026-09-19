import IosFold from './fold';
import { getIosInstanceClient } from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({ getIosInstanceClient: jest.fn() }));

const state = {
  angleDegrees: 90,
  orientation: 'portrait',
  minAngleDegrees: 0,
  maxAngleDegrees: 180,
  displays: [{ id: 'inner', screenId: 1, width: 900, height: 600, scale: 2 }],
};

function setup(angle?: string, orientation?: string) {
  const client = {
    getFoldState: jest.fn().mockResolvedValue(state),
    setHingeAngle: jest.fn().mockImplementation(async (angleDegrees) => ({ ...state, angleDegrees })),
    setDuoOrientation: jest.fn().mockImplementation(async (value) => ({ ...state, orientation: value })),
  };
  const disconnect = jest.fn();
  jest.mocked(getIosInstanceClient).mockResolvedValue({ client, disconnect } as never);
  const command = Object.assign(Object.create(IosFold.prototype), {
    parse: async () => ({ args: { angle }, flags: { json: true, orientation, id: 'ios_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => 'ios_test',
    outputJson: jest.fn(),
    error: (message: string): never => {
      throw new Error(message);
    },
  });
  Object.defineProperty(command, 'client', { value: {} });
  return { command, client, disconnect };
}

beforeEach(() => jest.clearAllMocks());

test('reading fold state does not change the device', async () => {
  const { command, client, disconnect } = setup();
  await command.run();
  expect(command.outputJson).toHaveBeenCalledWith(state);
  expect(client.setHingeAngle).not.toHaveBeenCalled();
  expect(client.setDuoOrientation).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('orientation can change without moving the hinge', async () => {
  const { command, client } = setup(undefined, 'landscape-left');
  await command.run();
  expect(client.setDuoOrientation).toHaveBeenCalledWith('landscape-left');
  expect(client.setHingeAngle).not.toHaveBeenCalled();
  expect(command.outputJson).toHaveBeenCalledWith({ ...state, orientation: 'landscape-left' });
});

test('sets orientation before a fractional hinge angle and returns the last native state', async () => {
  const { command, client } = setup('45.5', 'landscape-right');
  await command.run();
  expect(client.setHingeAngle).toHaveBeenCalledWith(45.5);
  expect(client.setDuoOrientation.mock.invocationCallOrder[0]).toBeLessThan(
    client.setHingeAngle.mock.invocationCallOrder[0]!,
  );
  expect(command.outputJson).toHaveBeenCalledWith({ ...state, angleDegrees: 45.5 });
});

test.each(['-1', '181', 'Infinity', 'NaN', 'text'])(
  'rejects invalid angle %s before connecting',
  async (angle) => {
    const { command } = setup(angle);
    await expect(command.run()).rejects.toThrow('between 0 and 180');
    expect(getIosInstanceClient).not.toHaveBeenCalled();
  },
);

test('ordinary simulators fail without issuing fold commands and disconnect', async () => {
  const { command, client, disconnect } = setup('90');
  client.getFoldState.mockResolvedValue(null);
  await expect(command.run()).rejects.toThrow('does not support native folding');
  expect(client.setHingeAngle).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test('native failures still release the connection', async () => {
  const { command, client, disconnect } = setup('90');
  client.setHingeAngle.mockRejectedValue(new Error('native failure'));
  await expect(command.run()).rejects.toThrow('native failure');
  expect(disconnect).toHaveBeenCalledTimes(1);
});
