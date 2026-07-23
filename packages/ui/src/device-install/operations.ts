/// <reference path="./webusb-dom.d.ts" />

import type { DeviceHello, DeviceInstallLog, PairRecordPayload } from './types';
import { RelayClient } from './relay-client';
import { closeUsbmuxSession, createUsbmuxSession, type UsbmuxSession } from './usbmux';
import { claimUsbmux, findUsbmuxCandidates, requestAppleDevice, type UsbmuxCandidate } from './webusb';
import { errorMessage } from '../core/errors';

export type DeviceRelayTarget = {
  device: USBDevice;
  candidate: UsbmuxCandidate;
  session?: UsbmuxSession;
  claimedInterfaceNumber?: number;
  hello: DeviceHello;
};

export type RequestUSBAccessOptions = {
  log?: DeviceInstallLog;
};

export type PairDeviceOptions = {
  registryApiUrl: string;
  token?: string;
  organizationId?: string;
  log?: DeviceInstallLog;
  target: DeviceRelayTarget;
};

export type InstallSource =
  | { assetId: string; assetName?: never; url?: never }
  | { assetId?: never; assetName: string; url?: never }
  | { assetId?: never; assetName?: never; url: string };

export type StartDeviceInstallOptions = PairDeviceOptions & {
  pairRecord: PairRecordPayload;
  installSource: InstallSource;
};

const noopLog: DeviceInstallLog = () => {};

export async function requestUSBAccess({ log = noopLog }: RequestUSBAccessOptions = {}) {
  log('Selecting USB device');
  const device = await requestAppleDevice();
  const target = makeDeviceRelayTarget(device);
  log(
    'Selected USB device',
    `${device.manufacturerName ?? ''} ${device.productName ?? ''} ${device.serialNumber ?? ''}`.trim(),
  );
  return target;
}

export async function pairDevice({
  registryApiUrl,
  token,
  organizationId,
  log = noopLog,
  target,
}: PairDeviceOptions) {
  const deviceRelayUrl = deviceRelayWebSocketUrl(registryApiUrl, token, organizationId);
  let relay: RelayClient | undefined;
  try {
    relay = await connectRelay(deviceRelayUrl, target, log);
    const pairRecord = await relay.startPairing();
    return { relay, pairRecord, target };
  } catch (error) {
    relay?.close();
    throw error;
  }
}

export async function startDeviceInstall({
  registryApiUrl,
  token,
  organizationId,
  log = noopLog,
  target,
  pairRecord,
  installSource,
}: StartDeviceInstallOptions) {
  const deviceRelayUrl = deviceRelayWebSocketUrl(registryApiUrl, token, organizationId);
  let relay: RelayClient | undefined;
  try {
    relay = await connectRelay(deviceRelayUrl, target, log);
    await relay.startInstall(pairRecord, installSource);
    return relay;
  } catch (error) {
    relay?.close();
    throw error;
  }
}

export async function closeDeviceRelayTarget(target: DeviceRelayTarget | undefined, log?: DeviceInstallLog) {
  if (!target) return;
  if (target.session) {
    closeUsbmuxSession(target.session);
    target.session = undefined;
  }
  if (target.claimedInterfaceNumber !== undefined) {
    try {
      await target.device.releaseInterface(target.claimedInterfaceNumber);
      log?.('Released usbmux interface');
    } catch (error) {
      log?.('USB interface release failed', errorMessage(error));
    } finally {
      target.claimedInterfaceNumber = undefined;
    }
  }
  if (target.device.opened) {
    try {
      await target.device.close();
      log?.('Closed USB device');
    } catch (error) {
      log?.('USB device close failed', errorMessage(error));
    }
  }
}

async function connectRelay(deviceRelayUrl: string, target: DeviceRelayTarget, log: DeviceInstallLog) {
  await ensureUsbmuxSession(target, log);
  const relay = new RelayClient(deviceRelayUrl, target.session!, target.hello, log);
  await relay.connect();
  return relay;
}

async function ensureUsbmuxSession(target: DeviceRelayTarget, log: DeviceInstallLog) {
  if (target.session) return;
  try {
    target.candidate = await claimBestUsbmuxCandidate(target, log);
    target.session = await createUsbmuxSession(target.device, target.candidate);
    log('Created usbmux session');
  } catch (error) {
    await closeDeviceRelayTarget(target, log);
    throw error;
  }
}

function makeDeviceRelayTarget(device: USBDevice): DeviceRelayTarget {
  return {
    device,
    candidate: pickUsbmuxCandidate(device),
    hello: {
      serialNumber: device.serialNumber,
      productName: device.productName,
      manufacturerName: device.manufacturerName,
      productId: device.productId,
      vendorId: device.vendorId,
    },
  };
}

async function claimBestUsbmuxCandidate(target: DeviceRelayTarget, log: DeviceInstallLog) {
  const candidates = orderedUsbmuxCandidates(target.device);
  if (candidates.length === 0) throw new Error('No Apple usbmux interface found.');
  let lastError: unknown;
  for (const candidate of candidates) {
    for (const attempt of [1, 2]) {
      try {
        if (!target.device.opened) {
          await target.device.open();
        }
        log(
          'Claiming usbmux interface',
          `configuration ${candidate.configurationValue}, interface ${candidate.interfaceNumber}, alternate ${candidate.alternateSetting}, attempt ${attempt}`,
        );
        await claimUsbmux(target.device, candidate);
        target.claimedInterfaceNumber = candidate.interfaceNumber;
        log(
          'Claimed usbmux interface',
          `configuration ${candidate.configurationValue}, interface ${candidate.interfaceNumber}`,
        );
        return candidate;
      } catch (error) {
        lastError = error;
        log(
          'USB interface claim failed',
          `configuration ${candidate.configurationValue}, interface ${
            candidate.interfaceNumber
          }: ${errorMessage(error)}`,
        );
        await resetUSBDevice(target);
        await sleep(250);
      }
    }
  }
  const detail = lastError ? ` (${errorMessage(lastError)})` : '';
  throw new Error(
    'Could not get exclusive USB access to the iPhone' +
      `${detail}. Another app on this computer is likely connected to it. ` +
      'Close other browser tabs that use this device, quit iPhone Mirroring, Xcode, eject iPhone in Finder windows showing the phone and try again.',
  );
}

function pickUsbmuxCandidate(device: USBDevice) {
  const candidate = orderedUsbmuxCandidates(device)[0];
  if (!candidate) throw new Error('No Apple usbmux interface found.');
  return candidate;
}

function orderedUsbmuxCandidates(device: USBDevice) {
  const candidates = findUsbmuxCandidates(device);
  const activeConfigurationValue = device.configuration?.configurationValue;
  return [
    ...candidates.filter((item) => item.configurationValue === activeConfigurationValue),
    ...candidates.filter((item) => item.configurationValue !== activeConfigurationValue),
  ];
}

export function deviceRelayWebSocketUrl(registryApiUrl: string, token?: string, organizationId?: string) {
  const url = new URL(registryApiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ios/device/ws`;
  if (token) {
    url.searchParams.set('token', token);
  }
  if (organizationId) {
    url.searchParams.set('organization', organizationId);
  }
  return url.toString();
}

async function resetUSBDevice(target: DeviceRelayTarget) {
  if (target.claimedInterfaceNumber !== undefined) {
    try {
      await target.device.releaseInterface(target.claimedInterfaceNumber);
    } catch {
      // Best effort: claim failures often mean there is nothing we own to release.
    }
    target.claimedInterfaceNumber = undefined;
  }
  if (target.device.opened) {
    try {
      await target.device.close();
    } catch {
      // Best effort before reopening for the next candidate/attempt.
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
