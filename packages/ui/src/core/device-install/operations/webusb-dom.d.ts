type USBTransferStatus = 'ok' | 'stall' | 'babble';

interface USBInTransferResult {
  data?: DataView;
  status: USBTransferStatus;
}

interface USBOutTransferResult {
  bytesWritten: number;
  status: USBTransferStatus;
}

interface USBDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  opened: boolean;
  configuration: { configurationValue: number } | null;
  configurations: Array<{
    configurationValue: number;
    interfaces: Array<{
      interfaceNumber: number;
      alternates: Array<{
        alternateSetting: number;
        interfaceClass: number;
        interfaceSubclass: number;
        interfaceProtocol: number;
        endpoints: Array<{
          endpointNumber: number;
          direction: 'in' | 'out';
          type: string;
          packetSize: number;
        }>;
      }>;
    }>;
  }>;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<USBOutTransferResult>;
}

interface Navigator {
  usb?: {
    requestDevice(options: { filters: Array<{ vendorId: number }> }): Promise<USBDevice>;
    getDevices(): Promise<USBDevice[]>;
  };
}
