import forge from 'node-forge';
import { sameUDID } from '../core/udid';

export type ProvisioningProfileInfo = {
  name?: string;
  uuid?: string;
  teamID?: string;
  applicationIdentifier?: string;
  bundleID?: string;
  provisionedDevices: string[];
  /**
   * Serial numbers (uppercase hex, no leading zeros) of the developer
   * certificates embedded in the profile; the profile is only usable for
   * signing with one of these certificates.
   */
  certificateSerialNumbers: string[];
  getTaskAllow?: boolean;
  expirationDate?: string;
};

export function profileContainsDevice(profile: ProvisioningProfileInfo, deviceUDID?: string) {
  return profile.provisionedDevices.some((device) => sameUDID(device, deviceUDID));
}

/** Matches exact bundle IDs plus Apple's `*` and `com.example.*` wildcards. */
export function profileMatchesBundleID(profile: ProvisioningProfileInfo, bundleID?: string) {
  const expected = (bundleID ?? '').trim();
  const profileBundleID = (profile.bundleID ?? '').trim();
  if (!expected || !profileBundleID) return false;
  if (profileBundleID === expected) return true;
  if (profileBundleID === '*') return true;
  if (!profileBundleID.endsWith('.*')) return false;
  return expected.startsWith(profileBundleID.slice(0, -1));
}

export async function parseProvisioningProfile(file: File) {
  return parseProvisioningProfileBytes(new Uint8Array(await file.arrayBuffer()));
}

export function parseProvisioningProfileBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return parseProvisioningProfileBytes(bytes);
}

export function parseProvisioningProfileBytes(bytes: Uint8Array) {
  const text = new TextDecoder('latin1').decode(bytes);
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < start) {
    throw new Error('Provisioning profile plist not found.');
  }
  const xml = text.slice(start, end + '</plist>'.length);
  // Defensively reject entity declarations before parsing: they are the vector
  // for XML entity-expansion (billion-laughs) attacks and never appear in a
  // real provisioning profile. The standard Apple `<!DOCTYPE plist PUBLIC ...>`
  // (an external DTD reference with no internal entity subset) is benign —
  // browsers' DOMParser does not fetch it — so it is intentionally allowed.
  if (/<!ENTITY/i.test(xml)) {
    throw new Error('Provisioning profile plist contains a disallowed ENTITY declaration.');
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Provisioning profile plist could not be parsed.');
  }
  const dict = doc.querySelector('plist > dict');
  if (!dict) {
    throw new Error('Provisioning profile plist dictionary not found.');
  }
  const value = readPlistValue(dict);
  if (!isRecord(value)) {
    throw new Error('Provisioning profile plist has an unexpected shape.');
  }
  const entitlements = isRecord(value.Entitlements) ? value.Entitlements : {};
  const applicationIdentifier = stringValue(entitlements['application-identifier']);
  const bundleID = bundleIDFromApplicationIdentifier(applicationIdentifier);
  return {
    name: stringValue(value.Name),
    uuid: stringValue(value.UUID),
    teamID:
      stringValue(entitlements['com.apple.developer.team-identifier']) ??
      stringArrayValue(value.TeamIdentifier)[0],
    applicationIdentifier,
    bundleID,
    provisionedDevices: stringArrayValue(value.ProvisionedDevices),
    certificateSerialNumbers: certificateSerialNumbers(stringArrayValue(value.DeveloperCertificates)),
    getTaskAllow: booleanValue(entitlements['get-task-allow']),
    expirationDate: stringValue(value.ExpirationDate),
  } satisfies ProvisioningProfileInfo;
}

/**
 * Normalizes a certificate serial number for comparison: uppercase hex
 * without leading zeros, the format Apple's portal reports in serialNum.
 */
export function normalizeCertificateSerial(serial?: string) {
  const normalized = (serial ?? '').replace(/^0+/, '').toUpperCase();
  return normalized || undefined;
}

/**
 * Reads the serial numbers of the DER certificates embedded in a profile's
 * DeveloperCertificates array. Unparseable entries are skipped: a profile
 * with an exotic certificate should degrade to weaker filtering, not fail
 * the whole parse.
 */
function certificateSerialNumbers(developerCertificatesBase64: string[]) {
  const serials: string[] = [];
  for (const entry of developerCertificatesBase64) {
    try {
      // Plist <data> payloads wrap base64 across lines; atob rejects whitespace.
      const der = atob(entry.replace(/\s+/g, ''));
      const certificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(der)));
      const serial = normalizeCertificateSerial(certificate.serialNumber);
      if (serial && !serials.includes(serial)) serials.push(serial);
    } catch {
      // Skip certificates forge cannot parse.
    }
  }
  return serials;
}

function bundleIDFromApplicationIdentifier(applicationIdentifier?: string) {
  if (!applicationIdentifier) return undefined;
  const dot = applicationIdentifier.indexOf('.');
  return dot >= 0 ? applicationIdentifier.slice(dot + 1) : undefined;
}

function readPlistValue(element: Element): unknown {
  switch (element.tagName) {
    case 'dict':
      return readPlistDict(element);
    case 'array':
      return Array.from(element.children).map(readPlistValue);
    case 'true':
      return true;
    case 'false':
      return false;
    default:
      return element.textContent ?? '';
  }
}

function readPlistDict(dict: Element) {
  const result: Record<string, unknown> = {};
  const children = Array.from(dict.children);
  for (let index = 0; index < children.length; index += 2) {
    const key = children[index];
    const value = children[index + 1];
    if (!key || key.tagName !== 'key' || !value) continue;
    result[key.textContent ?? ''] = readPlistValue(value);
  }
  return result;
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function booleanValue(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
