import type { SimulatorStatus } from '@limrun/api';
import { buildRunsOnSimulator } from './dsym';

describe('buildRunsOnSimulator', () => {
  const status: SimulatorStatus = {
    attached: true,
    simulator: { apiUrl: 'https://sim.example.test', iosInstanceId: 'ios_one' },
    latestBuild: {
      buildId: 'build-1',
      sdk: 'iphonesimulator',
      bundleId: 'com.example.app',
      installState: 'installedOnAttachedSimulator',
    },
  };

  it('accepts the latest build installed on the simulator being debugged', () => {
    expect(buildRunsOnSimulator(status, { id: 'ios_one' }, 'com.example.app')).toBe(true);
  });

  it('recognises a simulator targeted by URL, which has no instance ID to compare', () => {
    const byUrl = { id: 'ios_local_0123456789ab', apiUrl: 'https://sim.example.test/' };
    expect(buildRunsOnSimulator(status, byUrl, 'com.example.app')).toBe(true);
    const other = { id: 'ios_local_0123456789ab', apiUrl: 'https://other.example.test' };
    expect(buildRunsOnSimulator(status, other, 'com.example.app')).toBe(false);
  });

  it('rejects a build whose symbols would describe other code', () => {
    // Another simulator, another app, and a build that never reached the simulator.
    expect(buildRunsOnSimulator(status, { id: 'ios_two' }, 'com.example.app')).toBe(false);
    expect(buildRunsOnSimulator(status, { id: 'ios_one' }, 'com.example.other')).toBe(false);
    expect(
      buildRunsOnSimulator(
        { ...status, latestBuild: { ...status.latestBuild!, installState: 'notInstalled' } },
        { id: 'ios_one' },
        'com.example.app',
      ),
    ).toBe(false);
    expect(buildRunsOnSimulator({ attached: false }, { id: 'ios_one' }, 'com.example.app')).toBe(false);
  });
});
