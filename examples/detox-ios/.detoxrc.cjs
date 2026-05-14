const sessionId = process.env.DETOX_SESSION_ID || 'limrun-detox-example';
const server = process.env.DETOX_SERVER || 'ws://localhost:8099';
const deviceId = process.env.LIMRUN_IOS_ID || 'limrun-remote-ios';

/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      config: 'e2e/jest.config.cjs',
    },
    jest: {
      setupTimeout: 120000,
    },
  },
  session: {
    server,
    sessionId,
    debugSynchronization: 0,
  },
  behavior: {
    init: {
      reinstallApp: false,
      exposeGlobals: true,
    },
    cleanup: {
      shutdownDevice: false,
    },
  },
  devices: {
    limrun: {
      type: '@limrun/detox/driver',
      device: {
        id: deviceId,
      },
    },
  },
  configurations: {
    'ios.limrun.expo-go': {
      device: 'limrun',
    },
  },
};
