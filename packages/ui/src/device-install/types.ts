export type DeviceInstallLog = (message: string, detail?: string) => void;

export type DeviceHello = {
  serialNumber?: string;
  productName?: string;
  manufacturerName?: string;
  productId: number;
  vendorId: number;
};

export type PairRecordPayload = {
  udid: string;
  pairRecordBase64: string;
};

export type StoredPairRecord = PairRecordPayload & {
  productName?: string;
  updatedAt: string;
};
