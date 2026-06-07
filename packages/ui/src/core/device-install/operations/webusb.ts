/// <reference path="./webusb-dom.d.ts" />

export type UsbEndpoint = {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: string;
  packetSize: number;
};

export type UsbmuxCandidate = {
  configurationValue: number;
  interfaceNumber: number;
  alternateSetting: number;
  endpoints: UsbEndpoint[];
};

export async function requestAppleDevice() {
  if (!navigator.usb) {
    throw new Error('WebUSB is not available in this browser.');
  }
  return navigator.usb.requestDevice({ filters: [{ vendorId: 0x05ac }] });
}

export function findUsbmuxCandidates(device: USBDevice): UsbmuxCandidate[] {
  const candidates: UsbmuxCandidate[] = [];
  const activeConfigurationValue = device.configuration?.configurationValue;
  const activeConfiguration = device.configurations.find(
    (configuration) => configuration.configurationValue === activeConfigurationValue,
  );
  if (activeConfiguration) {
    candidates.push(...findConfigurationUsbmuxCandidates(activeConfiguration));
  }
  for (const configuration of device.configurations) {
    if (configuration.configurationValue === activeConfigurationValue) {
      continue;
    }
    candidates.push(...findConfigurationUsbmuxCandidates(configuration));
  }
  return candidates;
}

function findConfigurationUsbmuxCandidates(configuration: USBDevice['configurations'][number]): UsbmuxCandidate[] {
  const candidates: UsbmuxCandidate[] = [];
  for (const usbInterface of configuration.interfaces) {
    for (const alternate of usbInterface.alternates) {
      if (
        alternate.interfaceClass === 0xff &&
        alternate.interfaceSubclass === 0xfe &&
        alternate.interfaceProtocol === 0x02
      ) {
        candidates.push({
          configurationValue: configuration.configurationValue,
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          endpoints: alternate.endpoints,
        });
      }
    }
  }
  return candidates;
}

export async function claimUsbmux(device: USBDevice, candidate: UsbmuxCandidate) {
  if (!device.opened) {
    await device.open();
  }
  if (!device.configuration || device.configuration.configurationValue !== candidate.configurationValue) {
    await device.selectConfiguration(candidate.configurationValue);
  }
  await device.claimInterface(candidate.interfaceNumber);
  // Always select the alternate (even alt 0). On macOS Chrome the
  // interface's endpoints are not treated as active until the alternate
  // is explicitly selected, which otherwise surfaces as
  // "endpoint is not part of a claimed and selected alternate interface"
  // on the first transferIn/transferOut.
  await device.selectAlternateInterface(candidate.interfaceNumber, candidate.alternateSetting);
}

export function getBulkEndpoints(candidate: UsbmuxCandidate) {
  const outEndpoint = candidate.endpoints.find(
    (endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk',
  );
  const inEndpoint = candidate.endpoints.find(
    (endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk',
  );
  if (!outEndpoint || !inEndpoint) {
    throw new Error('Could not find usbmux bulk endpoints.');
  }
  return { outEndpoint, inEndpoint };
}

export async function transferOutWithZlp(device: USBDevice, endpoint: UsbEndpoint, bytes: Uint8Array) {
  const result = await device.transferOut(endpoint.endpointNumber, bytes);
  if (result.status !== 'ok') {
    throw new Error(`USB transferOut failed: ${result.status}`);
  }
  if (bytes.byteLength % endpoint.packetSize === 0) {
    await device.transferOut(endpoint.endpointNumber, new Uint8Array());
  }
}

export async function transferIn(device: USBDevice, endpoint: UsbEndpoint, size = 16384) {
  const result = await device.transferIn(endpoint.endpointNumber, size);
  if (result.status !== 'ok' || !result.data) {
    throw new Error(`USB transferIn failed: ${result.status}`);
  }
  return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
}
