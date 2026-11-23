import fs from 'fs';
import os from 'os';
import path from 'path';

const MACOS_TID = 'macos_euna_01m02anjqredzr42pcn8s8jx90';

function macosInstance() {
  return {
    metadata: { id: MACOS_TID, organizationId: 'org_01abc', createdAt: '2026-11-23T00:00:00Z' },
    spec: { region: 'eu-north1' },
    status: {
      state: 'ready' as const,
      apiUrl: 'https://node.example/v1/' + MACOS_TID + '/api',
      endpointWebSocketUrl: 'wss://node.example/v1/' + MACOS_TID + '/endpointWebSocket',
      token: 'control-token',
    },
  };
}

describe('macOS last-instance memory', () => {
  let home: string;
  let config: typeof import('./config');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-macos-'));
    jest.spyOn(os, 'homedir').mockReturnValue(home);
    jest.isolateModules(() => {
      config = require('./config');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('remembers a created macOS instance in its own slot and forgets it on delete', () => {
    const record = config.registerCreatedInstance(macosInstance() as never);
    expect(record).toMatchObject({ id: MACOS_TID, type: 'macos', token: 'control-token' });
    expect(config.loadLastMacosInstance()).toMatchObject({ id: MACOS_TID, type: 'macos' });
    expect(config.loadLastXcodeInstance()).toBeNull();

    config.clearLastInstanceId(MACOS_TID);
    expect(config.loadLastMacosInstance()).toBeNull();
  });
});
