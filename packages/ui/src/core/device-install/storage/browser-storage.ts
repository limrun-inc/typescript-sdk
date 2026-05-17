import type {
  ProvisioningProfileInfo,
  PutSigningAssetsInput,
  StoredPairRecord,
  StoredSigningAssets,
} from '../types';
import type { PairRecordPayload } from '../types';

const PAIRING_DB_NAME = 'limbuild-device-pairing';
const PAIRING_DB_VERSION = 1;
const PAIRING_STORE_NAME = 'pairRecords';
const SIGNING_DB_NAME = 'limbuild-device-signing';
const SIGNING_DB_VERSION = 1;
const SIGNING_STORE_NAME = 'signingAssets';

export function normalizeUDID(udid?: string) {
  return (udid ?? '').replace(/-/g, '').replace(/[^a-fA-F0-9]/g, '');
}

export function normalizeBundleID(bundleID?: string) {
  return (bundleID ?? '').trim();
}

export async function getPairRecord(udid?: string) {
  const normalized = normalizeUDID(udid);
  if (!normalized) return undefined;
  const db = await openDB(PAIRING_DB_NAME, PAIRING_DB_VERSION, PAIRING_STORE_NAME, 'udid');
  return requestToPromise<StoredPairRecord | undefined>(
    db.transaction(PAIRING_STORE_NAME, 'readonly').objectStore(PAIRING_STORE_NAME).get(normalized),
  );
}

export async function putPairRecord(record: PairRecordPayload, metadata: { productName?: string } = {}) {
  const normalized = normalizeUDID(record.udid);
  if (!normalized) throw new Error('Cannot store pair record without a UDID.');
  const stored: StoredPairRecord = {
    ...record,
    udid: normalized,
    productName: metadata.productName,
    updatedAt: new Date().toISOString(),
  };
  const db = await openDB(PAIRING_DB_NAME, PAIRING_DB_VERSION, PAIRING_STORE_NAME, 'udid');
  await requestToPromise(
    db.transaction(PAIRING_STORE_NAME, 'readwrite').objectStore(PAIRING_STORE_NAME).put(stored),
  );
  return stored;
}

export async function getSigningAssets({
  deviceUDID,
  bundleID,
}: {
  deviceUDID?: string;
  bundleID?: string;
}) {
  const normalizedBundleID = normalizeBundleID(bundleID);
  if (!normalizedBundleID) return undefined;
  const normalizedUDID = normalizeUDID(deviceUDID);
  if (normalizedUDID) {
    const exact = await getSigningAssetsByID(signingAssetID(normalizedUDID, normalizedBundleID));
    if (exact) return exact;
  }
  const candidates = await findSigningAssetsForBundle(normalizedBundleID);
  return candidates[0];
}

export async function getLatestSigningAssets() {
  const all = await getAllSigningAssets();
  return all.sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )[0];
}

export async function putSigningAssets(input: PutSigningAssetsInput) {
  const normalizedBundleID = normalizeBundleID(input.bundleID);
  if (!normalizedBundleID) {
    throw new Error('Cannot store signing assets without a bundle ID.');
  }
  const normalizedUDID = normalizeUDID(input.deviceUDID);
  const id = signingAssetID(normalizedUDID || 'bundle', normalizedBundleID);
  const stored: StoredSigningAssets = {
    ...input,
    id,
    deviceUDID: normalizedUDID || undefined,
    bundleID: normalizedBundleID,
    updatedAt: new Date().toISOString(),
  };
  const db = await openDB(SIGNING_DB_NAME, SIGNING_DB_VERSION, SIGNING_STORE_NAME, 'id');
  await requestToPromise(
    db.transaction(SIGNING_STORE_NAME, 'readwrite').objectStore(SIGNING_STORE_NAME).put(stored),
  );
  return stored;
}

export async function findSigningAssetsForBundle(bundleID?: string) {
  const normalized = normalizeBundleID(bundleID);
  if (!normalized) return [];
  const all = await getAllSigningAssets();
  return all.filter((asset) => asset.bundleID === normalized);
}

export function profileContainsDevice(profile: ProvisioningProfileInfo, deviceUDID?: string) {
  const normalized = normalizeUDID(deviceUDID);
  return !!normalized && profile.provisionedDevices.some((device) => normalizeUDID(device) === normalized);
}

export function profileMatchesBundleID(profile: ProvisioningProfileInfo, bundleID?: string) {
  const expected = normalizeBundleID(bundleID);
  const profileBundleID = normalizeBundleID(profile.bundleID);
  if (!expected || !profileBundleID) return false;
  if (profileBundleID === expected) return true;
  if (profileBundleID === '*') return true;
  if (!profileBundleID.endsWith('.*')) return false;
  const prefix = profileBundleID.slice(0, -1);
  return expected.startsWith(prefix);
}

export async function parseProvisioningProfile(file: File) {
  const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < start) {
    throw new Error('Provisioning profile plist not found.');
  }
  const xml = text.slice(start, end + '</plist>'.length);
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
    expirationDate: stringValue(value.ExpirationDate),
  } satisfies ProvisioningProfileInfo;
}

async function getSigningAssetsByID(id?: string) {
  if (!id) return undefined;
  const db = await openDB(SIGNING_DB_NAME, SIGNING_DB_VERSION, SIGNING_STORE_NAME, 'id');
  return requestToPromise<StoredSigningAssets | undefined>(
    db.transaction(SIGNING_STORE_NAME, 'readonly').objectStore(SIGNING_STORE_NAME).get(id),
  );
}

async function getAllSigningAssets() {
  const db = await openDB(SIGNING_DB_NAME, SIGNING_DB_VERSION, SIGNING_STORE_NAME, 'id');
  return requestToPromise<StoredSigningAssets[]>(
    db.transaction(SIGNING_STORE_NAME, 'readonly').objectStore(SIGNING_STORE_NAME).getAll(),
  );
}

function signingAssetID(deviceUDID: string, bundleID: string) {
  return `${deviceUDID}:${bundleID}`;
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
    case 'string':
    case 'date':
      return element.textContent ?? '';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openDB(dbName: string, dbVersion: number, storeName: string, keyPath: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Open IndexedDB failed'));
  });
}

function requestToPromise<T = unknown>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}
