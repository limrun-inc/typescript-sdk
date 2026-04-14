import { Command, Flags } from '@oclif/core';
import Limrun, { AuthenticationError } from '@limrun/api';
import { readConfig, resolveInstanceId } from './lib/config';
import { login } from './lib/auth';
import { renderTable } from './lib/formatting';

const VERSION = require('../package.json').version;

export abstract class BaseCommand extends Command {
  static baseFlags = {
    'api-key': Flags.string({
      description: 'API key for authentication',
      env: 'LIM_API_KEY',
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
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

  protected get parsedFlags(): Record<string, unknown> | undefined {
    return this._parsedFlags;
  }

  protected setParsedFlags(flags: Record<string, unknown>): void {
    this._parsedFlags = flags;
  }

  protected async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthenticationError) {
        const config = readConfig();
        this.log('Session expired. Logging in...');
        await login(config.consoleEndpoint, VERSION);
        this.log('You are logged in now.');
        // Reset client so it picks up the new key
        this._client = undefined;
        return fn();
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
      this.log(JSON.stringify(objects, null, 2));
    } else {
      this.log(renderTable(headers, rows));
    }
  }

  protected outputJson(data: unknown): void {
    this.log(JSON.stringify(data, null, 2));
  }

  /**
   * Resolve an instance ID from args, falling back to the last-used instance.
   * Infers expected type from the command alias (e.g. "ios screenshot" -> "ios").
   */
  protected resolveId(providedId: string | undefined): string {
    const commandId = this.id ?? '';
    const parts = commandId.split(' ');
    const noun = parts[0];
    const expectedType = ['ios', 'android', 'xcode'].includes(noun) ? noun : undefined;
    return resolveInstanceId(providedId, expectedType);
  }
}
