import { Command, Flags } from '@oclif/core';
import Limrun, { AuthenticationError, NotFoundError } from '@limrun/api';
import {
  clearInstanceCache,
  clearLastInstanceId,
  readConfig,
  registerCreatedInstance,
  resolveInstanceId,
  saveInstanceCache,
} from './lib/config';
import { login } from './lib/auth';
import { renderTable } from './lib/formatting';
import { stopDaemon } from './lib/daemon';

const VERSION = require('../package.json').version;
const INSTANCE_ID_PATTERN = /\b(?:ios|android|xcode|sandbox)_[a-z0-9]+\b/i;

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
          clearInstanceCache(instanceId);
          if (this.shouldAutoCreateOnNotFound()) {
            const replacementId = await this.createReplacementInstance(instanceId);
            if (replacementId) {
              this.info(
                `Instance ${instanceId} was not found. Created replacement instance ${replacementId}.`,
              );
              this._overrideInstanceId = replacementId;
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

  protected signedStreamUrl(status: { signedStreamUrl?: string } | undefined): string | undefined {
    return status?.signedStreamUrl;
  }

  /**
   * Resolve an instance ID from args, falling back to the last-used instance.
   * Infers expected type from the command alias (e.g. "ios screenshot" -> "ios").
   */
  protected resolveId(providedId: string | undefined): string {
    if (this._overrideInstanceId) {
      this._lastResolvedInstanceId = this._overrideInstanceId;
      return this._overrideInstanceId;
    }
    const parts = this.getCommandParts();
    const noun = parts[0];
    const expectedType =
      ['ios', 'android', 'xcode'].includes(noun) ? (noun as 'ios' | 'android' | 'xcode') : undefined;
    this._lastResolvedExpectedType = expectedType;
    const id = resolveInstanceId(providedId, expectedType);
    this._lastResolvedInstanceId = id;
    return id;
  }

  private findMissingInstanceId(err: NotFoundError): string | null {
    const match = err.message.match(INSTANCE_ID_PATTERN);
    if (match) {
      return match[0];
    }
    return this._lastResolvedInstanceId ?? null;
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

  private async createReplacementInstance(instanceId: string): Promise<string | null> {
    const commandType = this._lastResolvedExpectedType;
    const prefix = instanceId.split('_')[0];

    if (
      (commandType === 'xcode' && prefix === 'ios') ||
      (commandType === 'xcode' && instanceId.startsWith('ios_'))
    ) {
      const instance = await this.client.iosInstances.create({
        wait: true,
        spec: {
          sandbox: { xcode: { enabled: true } },
        },
      });
      saveLastCreatedInstance(instance.metadata.id, ['xcode']);
      const xcodeSandboxUrl = instance.status.sandbox?.xcode?.url;
      if (xcodeSandboxUrl) {
        saveInstanceCache(instance.metadata.id, {
          sandboxXcodeUrl: xcodeSandboxUrl,
          token: instance.status.token,
        });
      }
      return instance.metadata.id;
    }

    if (prefix === 'ios' || commandType === 'ios') {
      const instance = await this.client.iosInstances.create({ wait: true, spec: {} });
      saveLastCreatedInstance(instance.metadata.id);
      return instance.metadata.id;
    }

    if (prefix === 'android' || commandType === 'android') {
      const instance = await this.client.androidInstances.create({ wait: true, spec: {} });
      saveLastCreatedInstance(instance.metadata.id);
      return instance.metadata.id;
    }

    if (prefix === 'xcode' || prefix === 'sandbox' || commandType === 'xcode') {
      const instance = await this.client.xcodeInstances.create({ wait: true, spec: {} });
      saveLastCreatedInstance(instance.metadata.id);
      return instance.metadata.id;
    }

    return null;
  }

  private getCommandParts(): string[] {
    return (this.id ?? '').split(/[: ]+/).filter(Boolean);
  }
}

function saveLastCreatedInstance(
  instanceId: string,
  relatedTypes: Array<'ios' | 'android' | 'xcode'> = [],
): void {
  registerCreatedInstance(instanceId, relatedTypes);
}
