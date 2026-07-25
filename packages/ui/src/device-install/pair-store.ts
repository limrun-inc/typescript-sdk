import { openDB, requestToPromise } from '../core/indexeddb';
import { normalizeUDID } from '../core/udid';
import type { PairRecordPayload, StoredPairRecord } from './types';

const PAIRING_DB_NAME = 'limbuild-device-pairing';
const PAIRING_DB_VERSION = 1;
const PAIRING_STORE_NAME = 'pairRecords';

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
