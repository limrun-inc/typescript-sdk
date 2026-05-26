import { Command, Flags } from '@oclif/core';
import Limrun, { AuthenticationError, NotFoundError } from '@limrun/api';
import {
  clearLastInstanceId,
  loadAndroidInstanceCache,
  loadIosInstanceCache,
  loadLastAndroidInstance,
  loadLastIosInstance,
  loadLastXcodeInstance,
  loadXcodeInstanceCache,
  readConfig,
  registerCreatedInstance,
  type InstanceInput,
  type LastAndroidInstance,
  type LastIosInstance,
  type LastXcodeInstance,
} from './lib/config';
import { login } from './lib/auth';
import { renderTable } from './lib/formatting';
import { stopDaemon } from './lib/daemon';
import { detectInstanceType } from './lib/instance-client-factory';

const VERSION = require('../package.json').version;
const INSTANCE_ID_PATTERN = /\b(?:ios|android|xcode|sandbox)_[a-z0-9]+\b/i;
type XcodeTarget = LastIosInstance | LastXcodeInstance;

export abstract class BaseCommand extends Command {
  static baseFlags = {
    'api-key': Flags.string({
      description:
        'API key to use for this command. Overrides the saved login and can also be provided via LIM_API_KEY.',
      env: 'LIM_API_KEY',
    }),
    json: Flags.boolean({
      description:
        'Output structured JSON instead of human-readable tables or plain text when the command supports it.',
      default: false,
    }),
    quiet: Flags.boolean({
      description: 'Suppress intermediate human-readable logs and only emit the final result.',
      default: false,
    }),
    create: Flags.boolean({
      description: 'Create a replacement instance automatically if the target instance is not found.',
      default: true,
      allowNo: true,
    }),
  };

  private _client?: Limrun;

  protected get client(): Limrun {
    if (!this._client) {
      const config = readConfig();
      const flags = this.parsedFlags;
      const apiKey = flags?.['api-key'] || config.apiKey;
      const baseURL = config.apiEndpoint;

      if (!apiKey) {
        this.error('Not authenticated. Run `lim login` first, or provide --api-key.');
      }

      this._client = new Limrun({ apiKey: apiKey as string, baseURL });
    }
    return this._client;
  }

  private _parsedFlags?: Record<string, unknown>;
  private _lastResolvedInstanceId?: string;
  private _lastResolvedExpectedType?: 'ios' | 'android' | 'xcode';
  private _overrideInstanceId?: string;
  private _createRetryCount = 0;

  protected get parsedFlags(): Record<string, unknown> | undefined {
    return this._parsedFlags;
  }

  protected setParsedFlags(flags: Record<string, unknown>): void {
    this._parsedFlags = flags;
  }

  protected isJsonEnabled(): boolean {
    return Boolean(this.parsedFlags?.json);
  }

  protected isQuietEnabled(): boolean {
    return Boolean(this.parsedFlags?.quiet);
  }

  protected shouldSuppressInfo(): boolean {
    return this.isJsonEnabled() || this.isQuietEnabled();
  }

  protected info(message = ''): void {
    if (!this.shouldSuppressInfo()) {
      super.log(message);
    }
  }

  protected output(message = ''): void {
    super.log(message);
  }

  protected async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthenticationError) {
        const config = readConfig();
        this.info('Session expired. Logging in...');
        await login(config.consoleEndpoint, VERSION);
        this.info('You are logged in now.');
        // Reset client so it picks up the new key
        this._client = undefined;
        return this.withAuth(fn);
      }
      if (err instanceof NotFoundError) {
        const instanceId = this.findMissingInstanceId(err);
        if (instanceId) {
          stopDaemon(instanceId);
          clearLastInstanceId(instanceId);
          if (this.shouldAutoCreateOnNotFound()) {
            const replacement = await this.createReplacementInstance(instanceId);
            if (replacement) {
              this.info(
                `Instance ${instanceId} was not found. Created replacement instance ${replacement.id}.`,
              );
              this._overrideInstanceId = replacement.id;
              this._createRetryCount += 1;
              try {
                return await this.withAuth(fn);
              } finally {
                this._createRetryCount -= 1;
                this._overrideInstanceId = undefined;
              }
            }
          }
          this.error(
            `Instance ${instanceId} was not found. Local session and cached state were cleaned up. Either create a new instance or provide --id to target a different one.`,
          );
        }
      }
      throw err;
    }
  }

  protected outputTable(headers: string[], rows: string[][]): void {
    const flags = this.parsedFlags;
    if (flags?.json) {
      const objects = rows.map((row) => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
          obj[h.toLowerCase().replace(/\s+/g, '_')] = row[i] || '';
        });
        return obj;
      });
      this.output(JSON.stringify(objects, null, 2));
    } else {
      this.output(renderTable(headers, rows));
    }
  }

  protected outputJson(data: unknown): void {
    this.output(JSON.stringify(data, null, 2));
  }

  protected consoleStreamUrl(instanceId: string): string {
    const baseUrl = readConfig().consoleEndpoint.replace(/\/+$/, '');
    return `${baseUrl}/stream/${instanceId}`;
  }

  protected consoleBuildUrl(execId: string): string {
    const baseUrl = readConfig().consoleEndpoint.replace(/\/+$/, '');
    return `${baseUrl}/builds/${execId}`;
  }

  protected signedStreamUrl(status: { signedStreamUrl?: string } | undefined): string | undefined {
    return status?.signedStreamUrl;
  }

  protected async resolveXcodeClient(target: string | XcodeTarget) {
    const resolvedTarget = typeof target === 'string' ? this.xcodeTargetFromId(target) : target;
    const id = resolvedTarget.id;

    if (resolvedTarget.type === 'ios') {
      if (resolvedTarget.sandboxXcodeUrl && resolvedTarget.token) {
        try {
          return await this.client.xcodeInstances.createClient({
            apiUrl: resolvedTarget.sandboxXcodeUrl,
            token: resolvedTarget.token,
          });
        } catch (err) {
          if (this.isCachedXcodeClientNotFound(err)) {
            throw new NotFoundError(
              404,
              { message: `Instance ${id} was not found` },
              undefined,
              new Headers(),
            );
          }
          throw err;
        }
      }

      const instance = await this.client.iosInstances.get(id);
      let sandboxUrl = instance.status.sandbox?.xcode?.url;
      let token = instance.status.token;
      registerCreatedInstance(instance, ['xcode']);

      if (!sandboxUrl) {
        if (resolvedTarget.sandboxXcodeUrl) {
          sandboxUrl = resolvedTarget.sandboxXcodeUrl;
          token = resolvedTarget.token || token;
        }
      }

      if (!sandboxUrl) {
        this.error(
          `iOS instance ${id} does not have a Xcode sandbox. Create it with: lim ios create --xcode or lim xcode create --ios`,
        );
      }
      return this.client.xcodeInstances.createClient({
        apiUrl: sandboxUrl,
        token,
      });
    }

    if (resolvedTarget.apiUrl && resolvedTarget.token) {
      try {
        return await this.client.xcodeInstances.createClient({
          apiUrl: resolvedTarget.apiUrl,
          token: resolvedTarget.token,
        });
      } catch (err) {
        if (this.isCachedXcodeClientNotFound(err)) {
          throw new NotFoundError(404, { message: `Instance ${id} was not found` }, undefined, new Headers());
        }
        throw err;
      }
    }

    const instance = await this.client.xcodeInstances.get(id);
    registerCreatedInstance(instance);
    return this.client.xcodeInstances.createClient({ instance });
  }

  protected resolveAndroidInstance(providedId: string | undefined): LastAndroidInstance {
    this._lastResolvedExpectedType = 'android';
    const id = this._overrideInstanceId ?? providedId;
    if (id) {
      const instance = this.androidInstanceFromId(id);
      this._lastResolvedInstanceId = instance.id;
      return instance;
    }

    const instance = loadLastAndroidInstance();
    if (instance) {
      this._lastResolvedInstanceId = instance.id;
      return instance;
    }

    throw new Error(
      'No instance ID provided and no recentandroid instance found.\n' +
        'Provide an instance ID or create one first with: lim android create',
    );
  }

  protected resolveIosInstance(providedId: string | undefined): LastIosInstance {
    this._lastResolvedExpectedType = 'ios';
    const id = this._overrideInstanceId ?? providedId;
    if (id) {
      const instance = this.iosInstanceFromId(id);
      this._lastResolvedInstanceId = instance.id;
      return instance;
    }

    const instance = loadLastIosInstance();
    if (instance) {
      this._lastResolvedInstanceId = instance.id;
      return instance;
    }

    throw new Error(
      'No instance ID provided and no recentios instance found.\n' +
        'Provide an instance ID or create one first with: lim ios create',
    );
  }

  protected resolveDeviceInstance(providedId: string | undefined): LastAndroidInstance | LastIosInstance {
    if (providedId) {
      const type = detectInstanceType(providedId);
      if (type === 'android') {
        return this.resolveAndroidInstance(providedId);
      }
      if (type === 'ios') {
        return this.resolveIosInstance(providedId);
      }
      throw new Error('Sessions are for device interaction. Xcode instances use sync/build instead.');
    }

    const ios = loadLastIosInstance();
    if (ios) {
      this._lastResolvedExpectedType = 'ios';
      this._lastResolvedInstanceId = ios.id;
      return ios;
    }

    const android = loadLastAndroidInstance();
    if (android) {
      this._lastResolvedExpectedType = 'android';
      this._lastResolvedInstanceId = android.id;
      return android;
    }

    throw new Error(
      'No instance ID provided and no recentios or android instance found.\n' +
        'Provide an instance ID or create one first with: lim ios create or lim android create',
    );
  }

  protected async resolveXcodeTarget(providedId: string | undefined): Promise<XcodeTarget> {
    if (this._overrideInstanceId) {
      return this.xcodeTargetFromId(this._overrideInstanceId);
    }

    const parts = this.getCommandParts();
    this._lastResolvedExpectedType = 'xcode';
    if (providedId) {
      const target = this.xcodeTargetFromId(providedId);
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    const target = loadLastXcodeInstance();
    if (target) {
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    const noun = parts[0] ?? 'xcode';
    throw new Error(
      `No instance ID provided and no recent${noun} instance found.\n` +
        `Provide an instance ID or create one first with: lim ${noun} create`,
    );
  }

  protected async resolveXcodeTargetOrCreate(providedId: string | undefined): Promise<XcodeTarget> {
    try {
      return await this.resolveXcodeTarget(providedId);
    } catch (err) {
      if (!this.isMissingDefaultInstanceError(err) || !this.shouldAutoCreateOnNotFound()) {
        throw err;
      }

      const replacement = await this.createReplacementInstance();
      if (!replacement) {
        throw err;
      }

      const target = this.xcodeTargetFromRecord(replacement);
      this.info(`No recent xcode instance found. Created instance ${target.id}.`);
      this._lastResolvedInstanceId = target.id;
      return target;
    }
  }

  protected async resolveIosXcodeTargetOrCreate(providedId: string | undefined): Promise<LastIosInstance> {
    this._lastResolvedExpectedType = 'xcode';
    const id = this._overrideInstanceId ?? providedId;
    if (id) {
      const target = this.iosXcodeTargetFromId(id);
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    const target = loadLastXcodeInstance();
    if (target?.type === 'ios') {
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    if (!this.shouldAutoCreateOnNotFound()) {
      throw new Error(
        'No simulator-backed Xcode target found.\n' +
          'Create one first with: lim xcode create --ios, or rerun without --no-create.',
      );
    }

    const replacement = await this.createIosXcodeInstance();
    this.info(`No recent simulator-backed Xcode target found. Created instance ${replacement.id}.`);
    this._lastResolvedInstanceId = replacement.id;
    return replacement;
  }

  private findMissingInstanceId(err: NotFoundError): string | null {
    const match = err.message.match(INSTANCE_ID_PATTERN);
    if (match) {
      return match[0];
    }
    return this._lastResolvedInstanceId ?? null;
  }

  private isMissingDefaultInstanceError(err: unknown): err is Error {
    return err instanceof Error && err.message.startsWith('No instance ID provided and no recent');
  }

  private isCachedXcodeClientNotFound(err: unknown): err is Error {
    return err instanceof Error && err.message.includes('GET /info failed: 404');
  }

  private shouldAutoCreateOnNotFound(): boolean {
    if (this.parsedFlags?.create === false) {
      return false;
    }
    if (this._createRetryCount > 0) {
      return false;
    }
    const parts = this.getCommandParts();
    const noun = parts[0];
    const verb = parts[1];
    if (!['ios', 'android', 'xcode'].includes(noun)) {
      return false;
    }
    if (['create', 'delete', 'list'].includes(verb)) {
      return false;
    }
    return true;
  }

  private async createReplacementInstance(
    instanceId?: string,
  ): Promise<LastAndroidInstance | LastIosInstance | LastXcodeInstance | null> {
    const commandType = this._lastResolvedExpectedType;
    const prefix = instanceId?.split('_')[0];

    if (commandType === 'xcode' && prefix === 'ios') {
      return this.createIosXcodeInstance();
    }

    if (prefix === 'ios' || commandType === 'ios') {
      const instance = await this.client.iosInstances.create({ wait: true, spec: {} });
      saveLastCreatedInstance(instance);
      return loadLastIosInstance();
    }

    if (prefix === 'android' || commandType === 'android') {
      const instance = await this.client.androidInstances.create({ wait: true, spec: {} });
      saveLastCreatedInstance(instance);
      return loadLastAndroidInstance();
    }

    if (prefix === 'xcode' || prefix === 'sandbox' || commandType === 'xcode') {
      const instance = await this.client.xcodeInstances.create({ wait: true, spec: {} });
      saveLastCreatedInstance(instance);
      return loadLastXcodeInstance();
    }

    return null;
  }

  private getCommandParts(): string[] {
    return (this.id ?? '').split(/[: ]+/).filter(Boolean);
  }

  private xcodeTargetFromId(id: string): XcodeTarget {
    const type = detectInstanceType(id);
    if (type === 'ios') {
      const cached = loadIosInstanceCache(id);
      if (cached) return cached;
      return { id, type: 'ios' };
    }
    if (type === 'xcode') {
      const cached = loadXcodeInstanceCache(id);
      if (cached) return cached;
      return { id, type: 'xcode' };
    }
    throw new Error(`Expected an iOS or Xcode target, got ${id}`);
  }

  private iosXcodeTargetFromId(id: string): LastIosInstance {
    const target = this.xcodeTargetFromId(id);
    if (target.type === 'ios') {
      return target;
    }
    throw new Error(`--ios requires an iOS instance ID, got ${id}`);
  }

  private androidInstanceFromId(id: string): LastAndroidInstance {
    const type = detectInstanceType(id);
    if (type !== 'android') {
      throw new Error(`Expected an Android instance, got ${id}`);
    }
    return loadAndroidInstanceCache(id) ?? { id, type: 'android' };
  }

  private iosInstanceFromId(id: string): LastIosInstance {
    const type = detectInstanceType(id);
    if (type !== 'ios') {
      throw new Error(`Expected an iOS instance, got ${id}`);
    }
    return loadIosInstanceCache(id) ?? { id, type: 'ios' };
  }

  private xcodeTargetFromRecord(
    record: LastAndroidInstance | LastIosInstance | LastXcodeInstance,
  ): XcodeTarget {
    if (record.type === 'ios' || record.type === 'xcode') {
      return record;
    }
    throw new Error(`Expected an iOS or Xcode target, got ${record.id}`);
  }

  private async createIosXcodeInstance(): Promise<LastIosInstance> {
    const instance = await this.client.iosInstances.create({
      wait: true,
      spec: {
        sandbox: { xcode: { enabled: true } },
      },
    });
    saveLastCreatedInstance(instance, ['xcode']);
    const target = loadIosInstanceCache(instance.metadata.id);
    if (!target) {
      throw new Error(
        `Created iOS instance ${instance.metadata.id}, but failed to load it from local cache.`,
      );
    }
    return target;
  }
}

function saveLastCreatedInstance(instanceOrId: InstanceInput, relatedTypes: Array<'xcode'> = []): void {
  registerCreatedInstance(instanceOrId, relatedTypes);
}
