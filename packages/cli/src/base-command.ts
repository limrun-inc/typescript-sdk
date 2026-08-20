import { Command, Flags } from '@oclif/core';
import Limrun, { APIError, AuthenticationError, NotFoundError, XcodeCacheGoneError } from '@limrun/api';
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
import { envInstanceTarget } from './lib/set-instance';
import { renderTable } from './lib/formatting';
import { stopDaemon } from './lib/daemon';
import { detectInstanceType, setSessionAutoStart } from './lib/instance-client-factory';
import { deleteCreatedInstance } from './lib/instance-cleanup';
import { defaultSleep as sleep } from '@limrun/api';
import {
  parseCacheConfig,
  restoreOutcome,
  restoreProgressLine,
  saveOutcome,
  saveProgressLine,
  skippedKeyLines,
  wantsRestore,
} from './lib/cache';
import type { XcodeCacheConfig, XcodeCacheFollowResult } from '@limrun/api';
import { type IosInstance } from '@limrun/api/resources/ios-instances';
import { xcodeSandboxIdFromUrl } from './lib/xcode-sandbox';
import { captureTelemetry, telemetryIntentForCommand } from './lib/telemetry';

const VERSION = require('../package.json').version;
// Full instance-id shape only: prefix_region_suffix with a long TypeID suffix.
// TypeIDs are lowercase, so no /i flag; this avoids matching bare prefix words
// in error text (e.g. GRADLE_USER_HOME, gradle_wrapper) as if they were ids.
const INSTANCE_ID_PATTERN = /\b(?:ios|android|xcode|sandbox|gradle)_[a-z0-9]+_[a-z0-9]{20,}\b/;
type XcodeTarget = LastIosInstance | LastXcodeInstance;
type XcodeReplacementIntent = 'standalone' | 'simulator-backed';
type CachePublicationFollow =
  | { start: number; result: XcodeCacheFollowResult }
  | { start: number; error: unknown };
/**
 * A publication being watched, and a signal for when the watching has actually begun. The
 * deletion waits for the latter, because the transitions it wants to see are the ones it is
 * about to cause.
 */
type CachePublicationWatch = { opened: Promise<void>; done: Promise<CachePublicationFollow> };
/** How long a delete waits for its subscription before going ahead unwatched. */
const CACHE_FOLLOW_OPEN_TIMEOUT_MS = 5_000;

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
    daemon: Flags.boolean({
      description:
        'Route device commands through a background WebSocket daemon, starting it on first use, so repeated commands reuse the connection (~50ms instead of a fresh handshake). Disable with --no-daemon or LIM_DAEMON=false.',
      default: true,
      allowNo: true,
      env: 'LIM_DAEMON',
    }),
  };

  private _client?: Limrun;

  protected get client(): Limrun {
    if (!this._client) {
      const config = readConfig();
      const flags = this.parsedFlags;
      const apiKey = flags?.['api-key'] || config.apiKey;
      const baseURL = config.apiEndpoint;

      // Without a key, still hand out a client: instance-credential paths
      // (createClient with an instance apiUrl + token) never send the
      // management key, so set-instance and env-pinned targets work keyless.
      // An actual management call gets a 401 and flows into the existing
      // AuthenticationError handling, same as an expired key.
      this._client = new Limrun({ apiKey: (apiKey as string) || 'unauthenticated', baseURL });
    }
    return this._client;
  }

  private _parsedFlags?: Record<string, unknown>;
  private _lastResolvedInstanceId?: string;
  private _lastResolvedExpectedType?: 'ios' | 'android' | 'xcode' | 'gradle';
  private _xcodeReplacementIntent?: XcodeReplacementIntent;
  private _overrideInstanceId?: string;
  private _createRetryCount = 0;
  private _intentCaptured = false;
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
    setSessionAutoStart({
      enabled: flags['daemon'] !== false,
      silent: Boolean(flags['json']) || Boolean(flags['quiet']),
    });
    this.captureCommandIntent(flags);
  }

  private captureCommandIntent(flags: Record<string, unknown>): void {
    if (this._intentCaptured) return;
    const intent = telemetryIntentForCommand(this.id ?? '', flags);
    if (!intent) return;
    this._intentCaptured = true;
    void captureTelemetry(intent.event, intent.properties).catch(() => {});
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
  protected scopeSuffix(): string {
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
          `iOS instance ${id} does not have an Xcode sandbox. Create one and attach the simulator with: lim xcode create --attach --simulator-id ${id}`,
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

    const envTarget = envInstanceTarget('android');
    if (envTarget) {
      this._lastResolvedInstanceId = envTarget.id;
      return envTarget;
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

    const envTarget = envInstanceTarget('ios');
    if (envTarget) {
      this._lastResolvedInstanceId = envTarget.id;
      return envTarget;
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

    const envIos = envInstanceTarget('ios');
    if (envIos) {
      this._lastResolvedExpectedType = 'ios';
      this._lastResolvedInstanceId = envIos.id;
      return envIos;
    }

    const envAndroid = envInstanceTarget('android');
    if (envAndroid) {
      this._lastResolvedExpectedType = 'android';
      this._lastResolvedInstanceId = envAndroid.id;
      return envAndroid;
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

    const envTarget = envInstanceTarget('xcode');
    if (envTarget) {
      this._lastResolvedInstanceId = envTarget.id;
      return envTarget;
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

    // An env-pinned target is as explicit as --id: it wins over the cached
    // last-instance, is never bypassed for a fresh auto-created one, and
    // rejects creation-time settings the same way --id does.
    const envTarget = envInstanceTarget('xcode');
    if (envTarget) {
      if (this.autoCreateInactivityTimeout()) {
        throw new Error(
          '--inactivity-timeout controls a newly created instance and cannot be combined with an instance pinned by LIM_XCODE_INSTANCE_URL.',
        );
      }
      this._lastResolvedInstanceId = envTarget.id;
      return envTarget;
    }

    const target = loadLastXcodeInstance();
    // A requested creation-time timeout cannot be applied to an existing
    // instance. Skip the cached target so headless one-shot commands get a
    // fresh instance with the requested lifecycle.
    if (target?.type === 'xcode' && !this.autoCreateInactivityTimeout()) {
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
      if (target.type === 'xcode' && !(await this.xcodeTargetHasAttachedSimulator(target))) {
        throw new Error(
          `--ios requires an iOS-backed Xcode target or an Xcode instance with an attached simulator, got ${id}`,
        );
      }
      this._lastResolvedInstanceId = target.id;
      return target;
    }

    // An env-pinned target is as explicit as --id, so it gets the same
    // attached-simulator requirement instead of a silent fallback, and
    // rejects creation-time settings the same way --id does.
    const envTarget = envInstanceTarget('xcode');
    if (envTarget) {
      if (this.autoCreateInactivityTimeout()) {
        throw new Error(
          '--inactivity-timeout controls a newly created instance and cannot be combined with an instance pinned by LIM_XCODE_INSTANCE_URL.',
        );
      }
      if (!(await this.xcodeTargetHasAttachedSimulator(envTarget))) {
        throw new Error(
          `--ios requires an Xcode instance with an attached simulator, but the one pinned by LIM_XCODE_INSTANCE_URL (${envTarget.id}) has none. Attach one with: lim xcode attach-simulator`,
        );
      }
      this._lastResolvedInstanceId = envTarget.id;
      return envTarget;
    }

    const target = loadLastXcodeInstance();
    const forceFresh = Boolean(this.autoCreateInactivityTimeout());
    if (target?.type === 'ios' && !forceFresh) {
      this._lastResolvedInstanceId = target.id;
      return target;
    }
    // The recorded Xcode target wins even when it has no simulator yet:
    // attach one instead of abandoning it for a fresh sandbox, so a prior
    // `lim xcode sync` or `lim xcode create` keeps all commands pointed at
    // the same instance. Only a dead target falls through to creation.
    if (target?.type === 'xcode' && !forceFresh) {
      try {
        const xcodeClient = await this.resolveXcodeClient(target);
        const status = await xcodeClient.getSimulator();
        if (!status.attached) {
          // attachNewSimulator deletes the simulator itself when the attach fails.
          const { simulator } = await xcodeClient.attachNewSimulator();
          this._instancesCreatedThisRun.add(simulator.metadata.id);
          saveLastCreatedInstance(simulator);
          this.info(`Attached new simulator ${simulator.metadata.id} to Xcode target ${target.id}.`);
        }
        this._lastResolvedInstanceId = target.id;
        return target;
      } catch (err) {
        if (!(err instanceof NotFoundError) && !this.isCachedXcodeClientNotFound(err)) {
          throw err;
        }
        clearLastInstanceId(target.id);
      }
    }

    if (!this.shouldAutoCreateOnNotFound()) {
      throw new Error(
        'No simulator-backed Xcode target found.\n' +
          'Create one first with: lim xcode create --ios or lim xcode create --attach --simulator-id <ios-instance-ID>, or rerun without --no-create.',
      );
    }

    const replacement = await this.createSimulatorBackedXcodeInstance();
    this.info(`No recent simulator-backed Xcode target found. Created instance ${replacement.id}.`);
    this._lastResolvedInstanceId = replacement.id;
    return replacement;
  }

  private async xcodeTargetHasAttachedSimulator(target: LastXcodeInstance): Promise<boolean> {
    const xcodeClient = await this.resolveXcodeClient(target);
    const status = await xcodeClient.getSimulator();
    return status.attached;
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

  /** Creation-time inactivity timeout requested by commands such as xcode build. */
  private autoCreateInactivityTimeout(): string | undefined {
    const value = this.parsedFlags?.['inactivity-timeout'];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
          return this.createSimulatorBackedXcodeInstance();
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

  /** Build cache configuration from this command's flags, if it has any. */
  protected cacheConfigFromFlags(): XcodeCacheConfig | undefined {
    const flags = this.parsedFlags;
    if (!flags) return undefined;
    const asString = (name: string) =>
      typeof flags[name] === 'string' ? (flags[name] as string) : undefined;
    return parseCacheConfig({
      'cache-key': asString('cache-key'),
      'cache-restore-keys': asString('cache-restore-keys'),
      'cache-paths': asString('cache-paths'),
    });
  }

  /**
   * Blocks while a freshly created instance restores its cache, printing each phase as it
   * happens. A restore that fell back to a cold workspace just prints and returns, because the
   * instance is perfectly usable. A restore that genuinely broke removes the instance, since
   * the caller asked for a warm workspace and handing back a silently cold one is worse.
   */
  protected async awaitCacheRestore(
    cacheInstanceId: string,
    removeInstance: () => Promise<unknown>,
  ): Promise<void> {
    const start = Date.now();
    this.info('Restoring build cache...');
    let result;
    try {
      result = await this.client.xcodeInstances.followCache(cacheInstanceId, {
        onUpdate: (cache) => {
          const line = restoreProgressLine(cache);
          if (line) this.info(line);
        },
      });
    } catch (err) {
      if (err instanceof XcodeCacheGoneError) {
        // Not a wait that broke but an instance that ended, so there is nothing to keep or check.
        throw new Error(`Instance ${cacheInstanceId} was collected before its cache restore started.`);
      }
      // The restore may well still be running, so the instance stays: deleting it over a
      // client-side wait that broke would throw away a workspace that is probably fine.
      throw new Error(
        `Could not follow the cache restore of ${cacheInstanceId}: ${
          err instanceof Error ? err.message : String(err)
        }\n` + `The instance is still there. Check it with: lim xcode get ${cacheInstanceId}`,
      );
    }
    if (result.gone) {
      throw new Error(
        `Instance ${cacheInstanceId} was gone before its cache restore finished (last phase: ${result.cache.restore.phase}).`,
      );
    }
    const outcome = restoreOutcome(result.cache, Date.now() - start);
    if (outcome.failed) {
      await removeInstance();
      throw new Error(`${outcome.line}\nRemoved instance ${cacheInstanceId}.`);
    }
    this.info(outcome.line);
    if (result.cache.restore.phase !== 'restored') {
      for (const line of skippedKeyLines(result.cache)) {
        this.info(line);
      }
    }
  }

  /**
   * Applies cache flags to a target a command is about to build on. An instance this
   * invocation created already carries the whole configuration from its create, so all that is
   * left for an existing one is the destination key: restore keys and paths are settled when
   * the workspace directory is adopted and cannot be changed afterwards.
   */
  protected async applyBuildCacheToTarget(
    target: XcodeTarget,
    cache: XcodeCacheConfig | undefined,
  ): Promise<void> {
    if (!cache || this.wasCreatedThisRun(target.id)) {
      return;
    }
    if (cache.restoreKeys || cache.paths) {
      this.info(
        `Cache: instance ${target.id} already exists, so its restore keys and paths stay as they were created.`,
      );
    }
    if (cache.key) {
      await this.bindCacheKey(this.cacheInstanceId(target), cache.key);
    }
  }

  /**
   * The id the cache endpoints take. For an iOS-backed target that is its Xcode sandbox, which
   * is the instance that owns the workspace.
   */
  protected cacheInstanceId(target: XcodeTarget): string {
    if (target.type === 'ios') {
      return (
        xcodeSandboxIdFromUrl(target.sandboxXcodeUrl ?? target.status?.sandbox?.xcode?.url ?? '') ?? target.id
      );
    }
    return target.id;
  }

  /**
   * Binds the key an existing instance publishes under. The build happens now and publication
   * only at termination, possibly long after this process is gone, so the key has to live on
   * the instance rather than in this invocation.
   */
  protected async bindCacheKey(cacheInstanceId: string, key: string): Promise<void> {
    try {
      await this.client.xcodeInstances.bindCacheKey(cacheInstanceId, key);
      this.info(`Cache: publishing this workspace under ${key} when the instance terminates.`);
    } catch (err) {
      if (err instanceof APIError && err.message.includes('no cache workspace')) {
        throw new Error(
          `${err.message}\n` +
            `Publishing needs the stable workspace directory an instance only gets at create: lim xcode create --cache-key ${key}`,
        );
      }
      throw err;
    }
  }

  /**
   * Starts following an instance's cache publication before it is deleted, so a publication
   * that finishes quickly is still seen. Never rejects; the caller renders the result.
   */
  protected startCachePublicationFollow(cacheInstanceId: string): CachePublicationWatch {
    const start = Date.now();
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const done = this.client.xcodeInstances
      .followCache(cacheInstanceId, {
        side: 'save',
        onOpen: open,
        onUpdate: (cache) => {
          const line = saveProgressLine(cache);
          if (line) this.info(line);
        },
      })
      .then(
        (result): CachePublicationFollow => ({ start, result }),
        (error: unknown): CachePublicationFollow => ({ start, error }),
      );
    // A follow that ends without ever opening, on a 404 or a broken connection, must not leave
    // the deletion waiting on a subscription that is already over.
    return { opened: Promise.race([opened, done.then(() => {}), sleep(CACHE_FOLLOW_OPEN_TIMEOUT_MS)]), done };
  }

  /** Prints how a publication ended. Returns false when it did not publish what it should have. */
  protected async renderCachePublication(watch: CachePublicationWatch): Promise<boolean> {
    const followed = await watch.done;
    if ('error' in followed) {
      if (followed.error instanceof XcodeCacheGoneError) {
        // Nothing was published under this instance's key that this command could have waited
        // for: the region had already let it go by the time the stream opened. Not a failure,
        // since a publication that was underway holds the instance until it finishes.
        this.info('The instance was already gone, so it had no cache publication to report.');
        return true;
      }
      this.info(
        `Could not follow the cache publication: ${
          followed.error instanceof Error ? followed.error.message : String(followed.error)
        }`,
      );
      return false;
    }
    const outcome = saveOutcome(followed.result.cache, Date.now() - followed.start);
    this.info(outcome.line);
    return !outcome.failed;
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

  // Creates a standalone Xcode instance plus a fresh simulator and attaches
  // them, replacing the legacy server-side paired creation
  // (spec.sandbox.xcode.enabled). Separate creation keeps the two lifecycles
  // independent and is the supported way to get a simulator-backed target.
  // Deletes whatever it created when a later step fails, so nothing leaks.
  private async createSimulatorBackedXcodeInstance(): Promise<LastXcodeInstance> {
    const target = await this.createStandaloneXcodeInstance();
    const inactivityTimeout = this.autoCreateInactivityTimeout();
    let simulator: IosInstance | undefined;
    try {
      const xcodeClient = await this.resolveXcodeClient(target);
      simulator = await this.client.iosInstances.create({
        wait: true,
        spec: { ...(inactivityTimeout && { inactivityTimeout }) },
      });
      await xcodeClient.attachSimulator(simulator);
    } catch (err) {
      if (simulator) {
        await this.client.iosInstances.delete(simulator.metadata.id).catch(() => {});
      }
      await this.deleteCreatedInstance(target.id);
      throw err;
    }
    this._instancesCreatedThisRun.add(simulator.metadata.id);
    saveLastCreatedInstance(simulator);
    return target;
  }

  private async createStandaloneXcodeInstance(): Promise<LastXcodeInstance> {
    const inactivityTimeout = this.autoCreateInactivityTimeout();
    const cache = this.cacheConfigFromFlags();
    const instance = await this.client.xcodeInstances.create({
      wait: true,
      spec: {
        ...(inactivityTimeout && { inactivityTimeout }),
        ...(cache ? { cache } : {}),
      },
    });
    this._instancesCreatedThisRun.add(instance.metadata.id);
    saveLastCreatedInstance(instance);
    if (wantsRestore(cache)) {
      await this.awaitCacheRestore(instance.metadata.id, () =>
        this.deleteCreatedInstance(instance.metadata.id),
      );
    }
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
    // An env-pinned target is as explicit as --id: creation-time settings
    // cannot apply to it, so they error instead of silently auto-creating a
    // fresh billed instance while the pin is ignored.
    const envTarget = envInstanceTarget('gradle');
    if (envTarget) {
      if (this.autoCreateInactivityTimeout()) {
        throw new Error(
          '--inactivity-timeout controls a newly created instance and cannot be combined with an instance pinned by LIM_GRADLE_INSTANCE_URL.',
        );
      }
      this._lastResolvedInstanceId = envTarget.id;
      return envTarget;
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
    // Creation-time lifecycle settings cannot be applied to a cached target.
    if (target && !this.autoCreateInactivityTimeout()) {
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
    const inactivityTimeout = this.autoCreateInactivityTimeout();
    const instance = await this.client.gradleInstances.create({
      wait: true,
      spec: {
        ...(inactivityTimeout && { inactivityTimeout }),
      },
    });
    this._instancesCreatedThisRun.add(instance.metadata.id);
    // The save path builds the record from the instance we just created, so
    // the returned union member is necessarily the gradle shape.
    return saveLastCreatedInstance(instance) as LastGradleInstance;
  }
}

function saveLastCreatedInstance(instanceOrId: InstanceInput, relatedTypes: Array<'xcode'> = []) {
  return registerCreatedInstance(instanceOrId, relatedTypes);
}
