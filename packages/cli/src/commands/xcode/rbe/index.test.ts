import XcodeRbe from './index';
import { findBazelWorkspaceRoot } from '@limrun/api';
import { readRbePidFile, isProcessAlive } from '../../../lib/rbe-session';

jest.mock('@limrun/api', () => ({
  ...jest.requireActual('@limrun/api'),
  findBazelWorkspaceRoot: jest.fn(),
}));
jest.mock('../../../lib/rbe-session', () => ({
  ...jest.requireActual('../../../lib/rbe-session'),
  readRbePidFile: jest.fn(),
  isProcessAlive: jest.fn(),
}));

test.each([false, true])(
  'rejects unapplied permissions on an existing RBE tunnel (serve=%s)',
  async (serve) => {
    jest.mocked(findBazelWorkspaceRoot).mockReturnValue('/workspace');
    jest.mocked(readRbePidFile).mockReturnValue({ pid: 4321, instanceId: 'sandbox_euna_test', port: 8980 });
    jest.mocked(isProcessAlive).mockReturnValue(true);
    const withAuth = jest.fn();
    const command = Object.assign(Object.create(XcodeRbe.prototype), {
      parse: async () => ({
        flags: { serve, id: 'sandbox_euna_test', permission: ['asset:name/input.zip:read'] },
      }),
      setParsedFlags: jest.fn(),
      withAuth,
      error: (message: string) => {
        throw new Error(message);
      },
    });
    await expect(command.run()).rejects.toThrow(/--permission/);
    expect(withAuth).not.toHaveBeenCalled();
  },
);
