import { ensureDaemonSession, setSessionAutoStart } from './instance-client-factory';
import { isSessionActive } from './daemon-client';
import { type LastAndroidInstance, type LastIosInstance } from './config';

jest.mock('./daemon-client', () => ({
  isSessionActive: jest.fn(),
  sendCommand: jest.fn(),
}));

const isSessionActiveMock = isSessionActive as jest.Mock;

const IOS_TARGET: LastIosInstance = {
  id: 'ios_euna_01m02anjqredzr42pcn8s8jx90',
  type: 'ios',
  apiUrl: 'https://region.limrun.com/v1/ios_x/api',
  token: 'lim_st_token',
};

const ANDROID_TARGET: LastAndroidInstance = {
  id: 'android_euna_01m02anjqredzr42pcn8s8jx90',
  type: 'android',
  apiUrl: 'https://region.limrun.com/v1/android_x/api',
  token: 'lim_st_token',
  adbWebSocketUrl: 'wss://region.limrun.com/v1/android_x/adb',
};

describe('ensureDaemonSession', () => {
  let spawnFn: jest.Mock;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    isSessionActiveMock.mockReset();
    isSessionActiveMock.mockReturnValue(false);
    spawnFn = jest.fn().mockResolvedValue(undefined);
    stderr = jest.spyOn(console, 'error').mockImplementation(() => {});
    setSessionAutoStart({ enabled: true, silent: false });
  });

  afterEach(() => {
    stderr.mockRestore();
    setSessionAutoStart({ enabled: true, silent: false });
  });

  it('uses the existing session without spawning', async () => {
    isSessionActiveMock.mockReturnValue(true);
    await expect(ensureDaemonSession(IOS_TARGET, spawnFn)).resolves.toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not spawn when auto-start is disabled', async () => {
    setSessionAutoStart({ enabled: false });
    await expect(ensureDaemonSession(IOS_TARGET, spawnFn)).resolves.toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('does not spawn when credentials are not known yet', async () => {
    const idOnly: LastIosInstance = { id: IOS_TARGET.id, type: 'ios' };
    await expect(ensureDaemonSession(idOnly, spawnFn)).resolves.toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns with the target credentials and announces on stderr', async () => {
    await expect(ensureDaemonSession(IOS_TARGET, spawnFn)).resolves.toBe(true);
    expect(spawnFn).toHaveBeenCalledWith({
      instanceId: IOS_TARGET.id,
      instanceType: 'ios',
      apiUrl: IOS_TARGET.apiUrl,
      adbUrl: undefined,
      token: IOS_TARGET.token,
    });
    expect(stderr).toHaveBeenCalledWith(`WebSocket daemon started for ${IOS_TARGET.id}.`);
  });

  it('passes the adb url for android targets', async () => {
    await expect(ensureDaemonSession(ANDROID_TARGET, spawnFn)).resolves.toBe(true);
    expect(spawnFn).toHaveBeenCalledWith(
      expect.objectContaining({ instanceType: 'android', adbUrl: ANDROID_TARGET.adbWebSocketUrl }),
    );
  });

  it('stays quiet when silent', async () => {
    setSessionAutoStart({ enabled: true, silent: true });
    await expect(ensureDaemonSession(IOS_TARGET, spawnFn)).resolves.toBe(true);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('falls back to direct connection when the spawn fails', async () => {
    spawnFn.mockRejectedValue(new Error('boom'));
    await expect(ensureDaemonSession(IOS_TARGET, spawnFn)).resolves.toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      `Could not start WebSocket daemon for ${IOS_TARGET.id} (boom); connecting directly.`,
    );
  });
});
