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
  loadGradleInstanceCache,
  loadLastGradleInstance,
  type InstanceInput,
  type LastAndroidInstance,
  type LastIosInstance,
  type LastXcodeInstance,
  type LastGradleInstance,
} from './lib/config';
import { login } from './lib/auth';
import { getScopeKey, isGlobalScopeKey, setScopeOverride } from './lib/scope';
import { renderTable } from './lib/formatting';
import { stopDaemon } from './lib/daemon';
import { detectInstanceType } from './lib/instance-client-factory';
import { deleteCreatedInstance } from './lib/instance-cleanup';

const VERSION = require('../package.json').version;
// Full instance-id shape only: prefix_region_suffix with a long TypeID suffix.
// TypeIDs are lowercase, so no /i flag; this avoids matching bare prefix words
// in error text (e.g. GRADLE_USER_HOME, gradle_wrapper) as if they were ids.
const INSTANCE_ID_PATTERN = /\b(?:ios|android|xcode|sandbox|gradle)_[a-z0-9]+_[a-z0-9]{20,}\b/;
type XcodeTarget = LastIosInstance | LastXcodeInstance;
type XcodeReplacementIntent = 'standalone' | 'simulator-backed';

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
    workspace: Flags.string({
      description:
        'Workspace used to resolve the most recent instance when no ID is given. Defaults to the current git repo/worktree (or a `lim set-workspace-dir` assignment), so parallel agents in separate worktrees stay isolated automatically. Can also be set via LIM_WORKSPACE.',
      env: 'LIM_WORKSPACE',
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

  /** Credentials for backend endpoints outside the generated SDK client. */
  protected get apiCredentials(): { apiEndpoint: string; apiKey: string } {
    const config = readConfig();
    const apiKey = (this.parsedFlags?.['api-key'] as string | undefined) || config.apiKey;
    if (!apiKey) {
      this.error('Not authenticated. Run `lim login` first, or provide --api-key.');
    }
    return { apiEndpoint: config.apiEndpoint, apiKey };
  }

  private _parsedFlags?: Record<string, unknown>;
  private _lastResolvedInstanceId?: string;
  private _lastResolvedExpectedType?: 'ios' | 'android' | 'xcode' | 'gradle';
  private _xcodeReplacementIntent?: XcodeReplacementIntent;
  private _overrideInstanceId?: string;
  private _createRetryCount = 0;
  // Server-side instances THIS invocation created, so a path that abandons one
  // (e.g. it turns out not to support RBE) can delete it instead of leaking a
  // billed instance. Only instances we created are eligible — never a user
  // --id or a pre-existing cached instance. Protected so the factories that
  // populate it and the helpers that read it stay in one visibility tier.
  protected _instancesCreatedThisRun = new Set<string>();

  protected get parsedFlags(): Record<string, unknown> | undefined {
    return this._parsedFlags;
  }

  protected setParsedFlags(flags: Record<string, unknown>): void {
    this._parsedFlags = flags;
    const workspace = flags['workspace'];
    if (typeof workspace === 'string' && workspace.trim()) {
      setScopeOverride(workspace.trim());
    }
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

  /** ` in this workspace (<key>)`, or empty when resolved to the shared global slot. */
  private scopeSuffix(): string {
    const key = getScopeKey();
    return isGlobalScopeKey(key) ? '' : ` in this workspace (${key})`;
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
        await login(config.apiEndpoint, config.consoleEndpoint, VERSION, {
          log: (message) => this.info(message),
        });
        this.info('You are logged in now.');
        // Reset client so it picks up the new key
        this._client = undefined;
        return this.withAuth(fn);
      }
      if (err instanceof NotFoundError) {
        const explicitId = err.message.match(INSTANCE_ID_PATTERN)?.[0] ?? null;
        const instanceId = explicitId ?? this._lastResolvedInstanceId ?? null;
        if (instanceId) {
          stopDaemon(instanceId);
          clearLastInstanceId(instanceId);
          // Release an instance THIS invocation created so it doesn't keep
          // billing: eagerly when the error names it as gone, otherwise
          // only after a replacement is secured, because a 404 attributed
          // to _lastResolvedInstanceId by fallback may be misattributed
          // and the instance is only truly abandoned once the run has
          // switched away. Idempotent via the created-id set.
          if (explicitId) {
            await this.deleteCreatedInstance(explicitId);
          }
          if (this.shouldAutoCreateOnNotFound()) {
            const replacement = await this.createReplacementInstance(instanceId);
            if (replacement) {
              await this.deleteCreatedInstance(instanceId);
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

  /**
   * Runs the sibling `list` command (e.g. `ios:list` for `ios get`), forwarding
   * the base output/auth flags. Used by `get` commands to degrade to a listing
   * when no ID was given and no recent instance is remembered.
   */
  protected async runListFallback(commandId: string): Promise<void> {
    const flags = this.parsedFlags ?? {};
    const argv: string[] = [];
    if (flags['json']) argv.push('--json');
    if (flags['quiet']) argv.push('--quiet');
    if (typeof flags['api-key'] === 'string') argv.push('--api-key', flags['api-key'] as string);
    if (typeof flags['workspace'] === 'string') argv.push('--workspace', flags['workspace'] as string);
    await this.config.runCommand(commandId, argv);
  }

  protected consoleStreamUrl(instanceId: string): string {
    const baseUrl = readConfig().consoleEndpoint.replace(/\/+$/, '');
    return `${baseUrl}/stream/${instanceId}`;
  }

  // The console's builds page for an instance (where its live + persisted builds
  // appear). bazel streams to it via --bes_backend; this is just the link to view.
  protected consoleBuildUrl(instanceId: string): string {
    const baseUrl = readConfig().consoleEndpoint.replace(/\/+$/, '');
    return `${baseUrl}/builds/${instanceId}`;
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
      `No instance ID provided and no recent android instance found${this.scopeSuffix()}.\n` +
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
      `No instance ID provided and no recent ios instance found${this.scopeSuffix()}.\n` +
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
      throw new Error(
        'Sessions are for device interaction. Xcode and gradle instances use sync/build instead.',
      );
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
      `No instance ID provided and no recent ios or android instance found${this.scopeSuffix()}.\n` +
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
      `No instance ID provided and no recent ${noun} instance found${this.scopeSuffix()}.\n` +
        `Provide an instance ID or create one first with: lim ${noun} create`,
    );
  }

  protected async resolveXcodeTargetOrCreate(providedId: string | undefined): Promise<XcodeTarget> {
    this._lastResolvedExpectedType = 'xcode';
    this._xcodeReplacementIntent = 'standalone';
    const id = this._overrideInstanceId ?? providedId;
    if (id) {
      const target = this.xcodeTargetFromId(id);
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    const target = loadLastXcodeInstance();
    if (target?.type === 'xcode') {
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    if (!this.shouldAutoCreateOnNotFound()) {
      throw new Error(
        'No standalone Xcode target found.\n' +
          'Create one first with: lim xcode create, provide --id, or rerun without --no-create.',
      );
    }

    const replacement = await this.createStandaloneXcodeInstance();
    this.info(`No recent standalone Xcode target found. Created instance ${replacement.id}.`);
    this._lastResolvedInstanceId = replacement.id;
    return replacement;
  }

  protected async resolveSimulatorBackedXcodeTargetOrCreate(
    providedId: string | undefined,
  ): Promise<XcodeTarget> {
    this._lastResolvedExpectedType = 'xcode';
    this._xcodeReplacementIntent = 'simulator-backed';
    const id = this._overrideInstanceId ?? providedId;
    if (id) {
      const target = this.xcodeTargetFromId(id);
      if (target.type === 'xcode' && !(await this.xcodeTargetHasAttachedSimulator(target, false))) {
        throw new Error(
          `--ios requires an iOS-backed Xcode target or an Xcode instance with an attached simulator, got ${id}`,
        );
      }
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    const target = loadLastXcodeInstance();
    if (target?.type === 'ios') {
      this._lastResolvedInstanceId = target.id;
      return target;
    }
    if (target?.type === 'xcode' && (await this.xcodeTargetHasAttachedSimulator(target, true))) {
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    if (!this.shouldAutoCreateOnNotFound()) {
      throw new Error(
        'No simulator-backed Xcode target found.\n' +
          'Create one first with: lim xcode create --ios or lim xcode create --attach --simulator-id <ios-instance-ID>, or rerun without --no-create.',
      );
    }

    const replacement = await this.createIosXcodeInstance();
    this.info(`No recent simulator-backed Xcode target found. Created instance ${replacement.id}.`);
    this._lastResolvedInstanceId = replacement.id;
    return replacement;
  }

  private async xcodeTargetHasAttachedSimulator(
    target: LastXcodeInstance,
    clearIfMissing: boolean,
  ): Promise<boolean> {
    try {
      const xcodeClient = await this.resolveXcodeClient(target);
      const status = await xcodeClient.getSimulator();
      return status.attached;
    } catch (err) {
      if (clearIfMissing && (err instanceof NotFoundError || this.isCachedXcodeClientNotFound(err))) {
        clearLastInstanceId(target.id);
        return false;
      }
      throw err;
    }
  }

  private isCachedXcodeClientNotFound(err: unknown): err is Error {
    return (
      err instanceof Error &&
      (err.message.includes('GET /info failed: 404') || err.message.includes('GET /simulator failed: 404'))
    );
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
    if (!['ios', 'android', 'xcode', 'gradle'].includes(noun)) {
      return false;
    }
    // Read-only or lifecycle verbs must never conjure an instance: `lim
    // gradle get <typo>` should fail with not-found, not create-and-show a
    // brand new sandbox.
    if (['create', 'delete', 'list', 'get'].includes(verb)) {
      return false;
    }
    return true;
  }

  private async createReplacementInstance(
    instanceId?: string,
  ): Promise<LastAndroidInstance | LastIosInstance | LastXcodeInstance | LastGradleInstance | null> {
    // The command's resolved type outranks the id prefix: the retry re-runs
    // the SAME command, so the replacement must be what that command can
    // use. The prefix is only a fallback for 404s that arrive before any
    // resolution recorded a type (a stray foreign id embedded in an error
    // message must not switch the replacement's platform).
    let type = this._lastResolvedExpectedType ?? null;
    if (!type && instanceId) {
      try {
        type = detectInstanceType(instanceId);
      } catch {
        type = null;
      }
    }

    switch (type) {
      case 'gradle':
        return this.createStandaloneGradleInstance();
      case 'xcode':
        if (this._xcodeReplacementIntent === 'simulator-backed') {
          return this.createIosXcodeInstance();
        }
        return this.createStandaloneXcodeInstance();
      case 'ios': {
        const instance = await this.client.iosInstances.create({ wait: true, spec: {} });
        this._instancesCreatedThisRun.add(instance.metadata.id);
        saveLastCreatedInstance(instance);
        return loadLastIosInstance();
      }
      case 'android': {
        const instance = await this.client.androidInstances.create({ wait: true, spec: {} });
        this._instancesCreatedThisRun.add(instance.metadata.id);
        saveLastCreatedInstance(instance);
        return loadLastAndroidInstance();
      }
      default:
        return null;
    }
  }

  /** Whether `id` is a server-side instance THIS invocation auto-created. */
  protected wasCreatedThisRun(id: string | undefined): boolean {
    return !!id && this._instancesCreatedThisRun.has(id);
  }

  /**
   * Best-effort delete of an instance THIS invocation auto-created, so a path
   * that creates an instance and then abandons it (e.g. it does not support RBE,
   * or a retried command fails) does not leak a billed server-side instance.
   * Deletes directly (not via withAuth) so a 404 during cleanup can't trigger
   * replacement creation, mirrors `deleteSim`, and never throws. No-op for an
   * instance we did not create (a user --id or a pre-existing cached one). The
   * decision lives in `deleteCreatedInstance` (unit-tested without the oclif
   * runtime); the delete itself dispatches on the id prefix.
   */
  protected deleteCreatedInstance(id: string | undefined): Promise<boolean> {
    return deleteCreatedInstance(
      this._instancesCreatedThisRun,
      id,
      async (instanceId) => {
        const resources = {
          gradle: this.client.gradleInstances,
          xcode: this.client.xcodeInstances,
          ios: this.client.iosInstances,
          android: this.client.androidInstances,
        } as const;
        await resources[detectInstanceType(instanceId)].delete(instanceId);
      },
      (err) => this.debug(`best-effort delete of created instance ${id} failed:`, err),
    );
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

  private async createIosXcodeInstance(): Promise<LastIosInstance> {
    const instance = await this.client.iosInstances.create({
      wait: true,
      spec: {
        sandbox: { xcode: { enabled: true } },
      },
    });
    this._instancesCreatedThisRun.add(instance.metadata.id);
    saveLastCreatedInstance(instance, ['xcode']);
    const target = loadIosInstanceCache(instance.metadata.id);
    if (!target) {
      throw new Error(
        `Created iOS instance ${instance.metadata.id}, but failed to load it from local cache.`,
      );
    }
    return target;
  }

  private async createStandaloneXcodeInstance(): Promise<LastXcodeInstance> {
    const instance = await this.client.xcodeInstances.create({ wait: true, spec: {} });
    this._instancesCreatedThisRun.add(instance.metadata.id);
    saveLastCreatedInstance(instance);
    const target = loadLastXcodeInstance();
    if (!target || target.type !== 'xcode') {
      throw new Error(
        `Created Xcode instance ${instance.metadata.id}, but failed to load it from local cache.`,
      );
    }
    return target;
  }

  protected gradleTargetFromId(id: string): LastGradleInstance {
    if (detectInstanceType(id) !== 'gradle') {
      throw new Error(`Expected a gradle instance, got ${id}`);
    }
    return loadGradleInstanceCache(id) ?? { id, type: 'gradle' };
  }

  // Resolves the gradle target from an explicit id (or run override) or the
  // remembered last-used instance, recording the bookkeeping the self-heal
  // path relies on. Returns null when neither is available; callers decide
  // whether that is an error (get/delete) or a create trigger (build).
  private tryResolveGradleTarget(providedId: string | undefined): LastGradleInstance | null {
    this._lastResolvedExpectedType = 'gradle';
    const id = this._overrideInstanceId ?? providedId;
    if (id) {
      const target = this.gradleTargetFromId(id);
      this._lastResolvedInstanceId = target.id;
      return target;
    }
    const target = loadLastGradleInstance();
    if (target) {
      this._lastResolvedInstanceId = target.id;
      return target;
    }
    return null;
  }

  protected resolveGradleTarget(providedId: string | undefined): LastGradleInstance {
    const target = this.tryResolveGradleTarget(providedId);
    if (!target) {
      throw new Error(
        `No instance ID provided and no recent gradle instance found${this.scopeSuffix()}.\n` +
          'Provide an instance ID or create one first with: lim gradle create',
      );
    }
    return target;
  }

  protected async resolveGradleTargetOrCreate(providedId: string | undefined): Promise<LastGradleInstance> {
    const target = this.tryResolveGradleTarget(providedId);
    if (target) {
      return target;
    }

    if (!this.shouldAutoCreateOnNotFound()) {
      throw new Error(
        'No gradle target found.\n' +
          'Create one first with: lim gradle create, provide --id, or rerun without --no-create.',
      );
    }

    const replacement = await this.createStandaloneGradleInstance();
    this.info(`No recent gradle target found. Created instance ${replacement.id}.`);
    this._lastResolvedInstanceId = replacement.id;
    return replacement;
  }

  protected async resolveGradleClient(target: LastGradleInstance) {
    if (target.apiUrl && target.token) {
      return this.client.gradleInstances.createClient({ apiUrl: target.apiUrl, token: target.token });
    }
    const instance = await this.client.gradleInstances.get(target.id);
    saveLastCreatedInstance(instance);
    return this.client.gradleInstances.createClient({ instance });
  }

  private async createStandaloneGradleInstance(): Promise<LastGradleInstance> {
    const instance = await this.client.gradleInstances.create({ wait: true, spec: {} });
    this._instancesCreatedThisRun.add(instance.metadata.id);
    // The save path builds the record from the instance we just created, so
    // the returned union member is necessarily the gradle shape.
    return saveLastCreatedInstance(instance) as LastGradleInstance;
  }
}

function saveLastCreatedInstance(instanceOrId: InstanceInput, relatedTypes: Array<'xcode'> = []) {
  return registerCreatedInstance(instanceOrId, relatedTypes);
}
