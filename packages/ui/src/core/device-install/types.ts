export type DeviceInstallLog = (message: string, detail?: string) => void;

export type DeviceInstallStep = 'build' | 'usb' | 'pair' | 'install';

export type DeviceInstallStepStatus = 'idle' | 'active' | 'complete' | 'error';

export type DeviceInstallBusyAction = 'build' | 'usb' | 'pair' | 'install';

export type DeviceInstallBuildStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type BuildLogLine = {
  type: 'command' | 'stdout' | 'stderr' | 'meta';
  data: string;
};

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

export type ProvisioningProfileInfo = {
  name?: string;
  uuid?: string;
  teamID?: string;
  applicationIdentifier?: string;
  bundleID?: string;
  provisionedDevices: string[];
  expirationDate?: string;
};

export type StoredSigningAssets = {
  id: string;
  deviceUDID?: string;
  teamID?: string;
  bundleID: string;
  certificateID?: string;
  certificateP12Base64: string;
  certificateFileName?: string;
  certificatePassword: string;
  provisioningProfileBase64: string;
  profileFileName?: string;
  profile: ProvisioningProfileInfo;
  updatedAt: string;
};

export type PutSigningAssetsInput = Omit<StoredSigningAssets, 'id' | 'updatedAt'>;
