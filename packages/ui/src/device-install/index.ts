import {
  requestUSBAccess as requestCoreUSBAccess,
  startInstallRelay,
  startPairingRelay,
  type RequestUSBAccessOptions as CoreRequestUSBAccessOptions,
  type StartInstallRelayOptions,
  type StartPairingRelayOptions,
} from '../core/device-install/operations';
import type { DeviceInstallLog } from '../core/device-install/types';

export {
  closeDeviceRelayTarget,
  deviceRelayWebSocketUrl,
  startInstallRelay as startDeviceInstallRelay,
  startPairingRelay as startDevicePairingRelay,
  type DeviceRelayTarget,
  type StartInstallRelayOptions,
  type StartPairingRelayOptions,
} from '../core/device-install/operations';
export {
  getPairRecord,
  normalizeUDID,
  putPairRecord,
} from '../core/device-install/storage';
export type {
  DeviceHello,
  DeviceInstallLog,
  PairRecordPayload,
  StoredPairRecord,
} from '../core/device-install/types';
export { RelayClient } from '../core/device-install/operations';

export type RequestUSBAccessOptions = Partial<CoreRequestUSBAccessOptions>;

export async function requestUSBAccess(options: RequestUSBAccessOptions = {}) {
  return requestCoreUSBAccess({ log: options.log ?? noopLog });
}

export async function pairDevice(options: Omit<StartPairingRelayOptions, 'log'> & { log?: DeviceInstallLog }) {
  return startPairingRelay({ ...options, log: options.log ?? noopLog });
}

export async function startDeviceInstall(options: Omit<StartInstallRelayOptions, 'log'> & { log?: DeviceInstallLog }) {
  return startInstallRelay({ ...options, log: options.log ?? noopLog });
}

function noopLog() {
  // Intentionally empty. Consumers can pass a logger for progress messages.
}
