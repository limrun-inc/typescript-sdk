import IosFocusedElement from './focused-element';
import { ensureDaemonSession, sendSessionCommand } from '../../lib/instance-client-factory';

jest.mock('../../lib/instance-client-factory', () => ({
  ensureDaemonSession: jest.fn(),
  getIosInstanceClient: jest.fn(),
  sendSessionCommand: jest.fn(),
}));

function command() {
  return Object.assign(Object.create(IosFocusedElement.prototype), {
    parse: async () => ({ flags: { id: 'ios_test' } }),
    setParsedFlags: jest.fn(),
    withAuth: async (run: () => Promise<void>) => run(),
    resolveIosInstance: () => ({ id: 'ios_test' }),
    outputResult: jest.fn(),
  });
}

test('says when the focused input is under the keyboard', async () => {
  const keyboard = { frame: { x: 0, y: 546, width: 402, height: 328.4 } };
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  jest.mocked(sendSessionCommand).mockResolvedValue({ element: null, keyboard });

  const run = command();
  await run.run();

  expect(sendSessionCommand).toHaveBeenCalledWith('ios_test', 'focused-element');
  expect(run.outputResult).toHaveBeenCalledWith(
    { instanceId: 'ios_test', element: null, keyboard },
    expect.stringContaining('under the software keyboard at 0,546 402x328'),
  );
});

test('says when nothing has focus', async () => {
  jest.mocked(ensureDaemonSession).mockResolvedValue(true);
  jest.mocked(sendSessionCommand).mockResolvedValue({ element: null, keyboard: null });

  const run = command();
  await run.run();

  expect(run.outputResult).toHaveBeenCalledWith(
    { instanceId: 'ios_test', element: null, keyboard: null },
    'No element has focus.',
  );
});
