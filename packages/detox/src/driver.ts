// Detox loads third-party drivers via CommonJS and expects these named exports.
// Keep this module dependency-light: Detox itself is a peer of the consuming test project.

const fs = require('fs');
const IosDriver = require('detox/src/devices/runtime/drivers/ios/IosDriver');
const IosExpect = require('detox/src/ios/expectTwo');
const os = require('os');
const path = require('path');
const XCUITestRunner = require('detox/src/ios/XCUITestRunner');

const { Ios } = require('@limrun/api');

export type LimrunDetoxDeviceConfig = {
  device?: {
    id?: string;
    name?: string;
  };
};

export type LimrunDetoxDeviceCookie = {
  id: string;
  name: string;
  type: string;
};

export class DeviceAllocationDriverClass {
  async allocate(deviceConfig: LimrunDetoxDeviceConfig & { type: string }): Promise<LimrunDetoxDeviceCookie> {
    const id = deviceConfig.device?.id || process.env['LIMRUN_IOS_ID'] || 'limrun-remote-ios';
    return {
      id,
      name: deviceConfig.device?.name || id,
      type: deviceConfig.type,
    };
  }

  async postAllocate(cookie: LimrunDetoxDeviceCookie): Promise<LimrunDetoxDeviceCookie> {
    return cookie;
  }

  async free(): Promise<void> {}

  async cleanup(): Promise<void> {}
}

export class RuntimeDriverClass extends IosDriver {
  private readonly id: string;
  private readonly name: string;
  private limrunClient?: any;

  constructor(deps: unknown, cookie: LimrunDetoxDeviceCookie) {
    super(deps);
    this.id = cookie.id;
    this.name = cookie.name || cookie.id;
  }

  validateDeviceConfig(): void {}

  getExternalId(): string {
    return this.id;
  }

  getDeviceName(): string {
    return this.name;
  }

  async waitForActive(): Promise<void> {
    if (process.env['LIMRUN_DETOX_APP_PREPARED'] !== 'true') {
      return;
    }
    await this['client'].waitForActive();
  }

  async waitForBackground(): Promise<void> {
    await this['client'].waitForBackground();
  }

  async cleanup(bundleId?: string): Promise<void> {
    this.limrunClient?.disconnect?.();
    this.limrunClient = undefined;
    await super.cleanup(bundleId);
  }

  async takeScreenshot(screenshotName: string): Promise<string> {
    const client = await this.getLimrunClient();
    const extension = 'jpg';
    const artifactName = screenshotName || `limrun-detox-${Date.now()}`;
    const artifactRoot =
      process.env['DETOX_ARTIFACTS_DIR'] ?
        path.join(process.env['DETOX_ARTIFACTS_DIR'], 'detox-artifacts')
      : os.tmpdir();
    fs.mkdirSync(artifactRoot, { recursive: true });
    const screenshotPath = path.join(artifactRoot, `${artifactName}.${extension}`);

    try {
      const screenshot = await client.screenshot();
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.base64, 'base64'));
      return screenshotPath;
    } catch (error) {
      this.limrunClient?.disconnect?.();
      this.limrunClient = undefined;
      throw error;
    }
  }

  private async getLimrunClient(): Promise<any> {
    if (this.limrunClient) {
      return this.limrunClient;
    }

    const apiUrl = process.env['LIMRUN_IOS_API_URL'];
    const token = process.env['LIMRUN_IOS_TOKEN'];
    if (!apiUrl || !token) {
      throw new Error('Missing LIMRUN_IOS_API_URL or LIMRUN_IOS_TOKEN for Limrun Detox screenshots.');
    }

    this.limrunClient = await Ios.createInstanceClient({
      apiUrl,
      token,
      logLevel: 'none',
    });
    return this.limrunClient;
  }
}

export class ExpectClass {
  constructor({ invocationManager, runtimeDevice, eventEmitter }: any) {
    return new IosExpect({
      invocationManager,
      xcuitestRunner: new XCUITestRunner({ runtimeDevice }),
      emitter: eventEmitter,
    });
  }
}
