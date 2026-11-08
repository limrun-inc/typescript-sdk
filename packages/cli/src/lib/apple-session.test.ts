import prompts from 'prompts';
import { startAppleIDLogin, listAppleTeams } from '@limrun/apple-auth';
import { withAppleSession } from './apple-session';

jest.mock('prompts', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@limrun/apple-auth', () => ({ startAppleIDLogin: jest.fn(), listAppleTeams: jest.fn() }));
const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const flags = { account: 'user@example.com', 'registry-endpoint': 'https://registry.example.test' };
const close = jest.fn();
const finishTwoFactor = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  jest
    .mocked(prompts)
    .mockResolvedValueOnce({ password: 'private-password' })
    .mockResolvedValueOnce({ code: '123456' });
  jest.mocked(startAppleIDLogin).mockResolvedValue({
    relay: {},
    requiresTwoFactor: true,
    finishTwoFactor,
    finalize: async () => ({ status: 200 }),
    close,
  } as unknown as Awaited<ReturnType<typeof startAppleIDLogin>>);
  jest.mocked(listAppleTeams).mockResolvedValue([{ teamId: 'TEAM', providerId: '123' }]);
});
afterAll(() => {
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
});
test('uses the selected team and always closes after a failed operation', async () => {
  const action = jest.fn(async (context) => {
    expect(context.team.teamId).toBe('TEAM');
    throw new Error('mutation failed');
  });
  await expect(withAppleSession('token', flags, action)).rejects.toThrow('mutation failed');
  expect(action).toHaveBeenCalledTimes(1);
  expect(finishTwoFactor).toHaveBeenCalledWith('123456');
  expect(close).toHaveBeenCalledTimes(1);
});
test('rejects an unavailable team and closes the session', async () => {
  const action = jest.fn();
  await expect(withAppleSession('token', { ...flags, 'team-id': 'WRONG' }, action)).rejects.toThrow(
    'not available',
  );
  expect(action).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
test('team listing does not force team selection', async () => {
  await withAppleSession('token', flags, async () => [], false);
  expect(listAppleTeams).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});
test('requires a terminal before requesting a password', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  await expect(withAppleSession('token', flags, jest.fn())).rejects.toThrow('interactive terminal');
  expect(prompts).not.toHaveBeenCalled();
  expect(startAppleIDLogin).not.toHaveBeenCalled();
});
