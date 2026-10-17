import Feedback from './feedback';
import { feedbackSender, sendFeedback } from '../lib/backend';
import { readConfig } from '../lib/config';

jest.mock('../lib/backend', () => ({
  feedbackSender: jest.fn(),
  sendFeedback: jest.fn(async () => {}),
}));
jest.mock('../lib/config', () => ({ readConfig: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readConfig).mockReturnValue({ apiKey: 'lim_key' } as ReturnType<typeof readConfig>);
  jest.mocked(feedbackSender).mockResolvedValue({ organizationId: 'org_1', emailAddress: 'dev@example.com' });
});

/** Runs feedback with parsed args and flags, capturing what it prints. */
function setup(args: Record<string, unknown>, flags: Record<string, unknown> = {}) {
  const output = jest.fn();
  const command = Object.assign(Object.create(Feedback.prototype), {
    parse: async () => ({ args, flags: { json: false, quiet: false, ...flags } }),
    setParsedFlags: jest.fn(),
    _client: {},
    config: { userAgent: 'lim/1.2.3 linux-x64 node-v22' },
    output,
    outputJson: jest.fn(),
    error: (message: string) => {
      throw new Error(message);
    },
  });
  return { command: command as Feedback, output };
}

test('attributes feedback to the logged-in organization and user', async () => {
  const { command, output } = setup({ message: '  sheet buttons are missing  ' });
  await command.run();
  expect(sendFeedback).toHaveBeenCalledWith(
    {},
    'sheet buttons are missing\n\n---\ncli: lim/1.2.3 linux-x64 node-v22\norganization: org_1',
    'dev@example.com',
  );
  expect(output).toHaveBeenCalledWith('Thanks! Your feedback was sent to the Limrun team.');
});

test('sends anonymously without a credential and prefers --email', async () => {
  jest.mocked(readConfig).mockReturnValue({} as ReturnType<typeof readConfig>);
  const { command } = setup({ message: 'hello' }, { email: 'me@example.com' });
  await command.run();
  expect(feedbackSender).not.toHaveBeenCalled();
  expect(sendFeedback).toHaveBeenCalledWith(
    {},
    'hello\n\n---\ncli: lim/1.2.3 linux-x64 node-v22',
    'me@example.com',
  );
});

test('refuses an empty message', async () => {
  const { command } = setup({ message: '   ' });
  await expect(command.run()).rejects.toThrow('Pass the feedback');
  expect(sendFeedback).not.toHaveBeenCalled();
});
