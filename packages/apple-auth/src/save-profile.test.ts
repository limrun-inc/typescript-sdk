// Runs in the default jsdom environment: parseProvisioningProfileBase64
// needs DOMParser to read the profile plist.

import { describe, expect, test } from 'vitest';
import type { AppleRelayWebSocketClient } from './relay';
import {
  parseProvisionedDevices,
  saveAppleProfileSecret,
  type SigningSecret,
  type SigningSecretMetadata,
  type SigningSecretStore,
  type SigningSecretType,
} from './index';

function memorySecretStore(): SigningSecretStore {
  const entries = new Map<string, SigningSecret>();
  return {
    async put(type: SigningSecretType, name: string, data: Record<string, string>) {
      const secret: SigningSecret = { type, name, data, createdAt: new Date().toISOString() };
      entries.set(`${type}:${name}`, secret);
      return secret;
    },
    async get(type: SigningSecretType, name: string) {
      return entries.get(`${type}:${name}`);
    },
    async list() {
      return [...entries.values()].map(({ data: _data, ...metadata }): SigningSecretMetadata => metadata);
    },
    async delete(type: SigningSecretType, name: string) {
      entries.delete(`${type}:${name}`);
    },
  };
}

function deviceProfileBase64(udids: string[]) {
  const devices =
    udids.length > 0 ?
      `<key>ProvisionedDevices</key><array>${udids
        .map((udid) => `<string>${udid}</string>`)
        .join('')}</array>`
    : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Name</key><string>Limrun Dev</string>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
  <key>TeamIdentifier</key><array><string>TEAM1</string></array>
  ${devices}
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>TEAM1.com.example.app</string>
  </dict>
</dict>
</plist>`;
  return btoa(xml);
}

/**
 * Fakes the relay for profile download plus the portal device list the
 * device enrichment joins against. Profiles without devices must not hit
 * the device list at all, so that path is only served when provided.
 */
function fakeProfileRelay(profileB64: string, devices?: Array<Record<string, unknown>>) {
  return {
    async request(_type: string, payload: unknown) {
      const request = payload as { path: string };
      if (request.path.includes('downloadProfileContent')) {
        return { status: 200, statusText: 'OK', rawBodyBase64: profileB64 };
      }
      if (request.path.includes('listDevices') && devices) {
        return { status: 200, statusText: 'OK', body: { resultCode: 0, devices } };
      }
      throw new Error(`unexpected portal path: ${request.path}`);
    },
  } as unknown as AppleRelayWebSocketClient;
}

describe('saveAppleProfileSecret', () => {
  test('stores provisioned devices as JSON enriched with their portal names', async () => {
    const store = memorySecretStore();
    const relay = fakeProfileRelay(deviceProfileBase64(['00008030-000A', '00008110-000B']), [
      {
        deviceId: 'D1',
        deviceNumber: '00008030-000A',
        name: "Muvaffak's iPhone",
        model: 'iPhone 14 Pro',
      },
    ]);

    const secret = await saveAppleProfileSecret({
      relay,
      teamId: 'TEAM1',
      profileId: 'PROF1',
      secretStore: store,
    });
    expect(parseProvisionedDevices(secret.data.deviceIDs)).toEqual([
      { udid: '00008030-000A', name: "Muvaffak's iPhone", model: 'iPhone 14 Pro' },
      { udid: '00008110-000B' },
    ]);
  });

  test('omits deviceIDs for profiles without devices and skips the device list', async () => {
    const store = memorySecretStore();
    const relay = fakeProfileRelay(deviceProfileBase64([]));

    const secret = await saveAppleProfileSecret({
      relay,
      teamId: 'TEAM1',
      profileId: 'PROF1',
      secretStore: store,
    });
    expect(secret.data.deviceIDs).toBeUndefined();
  });
});
