import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Limrun from './index';
import { createServeSimAdapter } from './serve-sim';
import { createInstanceClient as createIosClient } from './ios-client';
import { createInstanceClient as createAndroidClient } from './instance-client';

export type DeviceHostTarget =
  | { platform: 'ios'; model: 'iphone' | 'ipad' | 'iphone-duo' }
  | { platform: 'android'; model: 'phone' | 'tablet' };
export const deviceHostCatalog: ReadonlyArray<DeviceHostTarget & { name: string }> = [
  { platform: 'ios', model: 'iphone', name: 'iPhone' },
  { platform: 'ios', model: 'ipad', name: 'iPad' },
  { platform: 'android', model: 'phone', name: 'Android phone' },
  { platform: 'android', model: 'tablet', name: 'Android tablet' },
  { platform: 'ios', model: 'iphone-duo', name: 'iPhone Duo' },
];
export type DeviceHostInstance = Limrun.IosInstance | Limrun.AndroidInstance;
export type DeviceHostSession = DeviceHostTarget & {
  id: string;
  slot: string;
  instance: DeviceHostInstance;
  agentEnv: Record<string, string>;
};
export interface ServeSimHostOptions {
  client: Limrun;
  /** Persist this identity across restarts; recovery deletes only instances with this label. */
  owner: { label: string; value: string };
  allocationLabel: string;
  displayName: string;
  region: string;
  hardTimeout: string;
  inactivityTimeout: string;
  maxConcurrentSessions: number;
  onError: (operation: string, id: string, error: unknown) => void;
}

type Runtime =
  | { platform: 'ios'; client: Awaited<ReturnType<typeof createIosClient>> }
  | { platform: 'android'; client: Awaited<ReturnType<typeof createAndroidClient>> };
type Running = {
  session: DeviceHostSession;
  runtime?: Runtime;
  heartbeat?: ReturnType<typeof setInterval>;
};

/** Owns cloud instances behind a serve-sim/serve-emu hub, without relaying WebRTC media. */
export async function createServeSimHost(options: ServeSimHostOptions) {
  const { client } = options;
  const live = new Map<string, Running>();
  let recovered = false;
  let closed = false;
  let pending: (DeviceHostTarget & { slot: string }) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const get = (platform: 'ios' | 'android', id: string, signal?: AbortSignal) =>
    platform === 'ios' ?
      client.iosInstances.get(id, { signal })
    : client.androidInstances.get(id, { signal });
  const destroy = async (platform: 'ios' | 'android', id: string) => {
    try {
      if (platform === 'ios') await client.iosInstances.delete(id);
      else await client.androidInstances.delete(id);
    } catch (error) {
      if (!(error instanceof Limrun.APIError) || error.status !== 404) throw error;
    }
  };
  const owned = (id: string) => {
    const item = live.get(id);
    if (!item || closed) throw new Error('Instance has ended.');
    return item;
  };
  const hub = await createServeSimAdapter({
    resolveDevice: async (id) => {
      const item = live.get(id);
      if (!item || closed) return undefined;
      const { platform, instance } = item.session;
      const { token, apiUrl, endpointWebSocketUrl } = instance.status;
      if (!token || !apiUrl || !endpointWebSocketUrl) return undefined;
      return {
        platform,
        apiUrl,
        endpoint: endpointWebSocketUrl,
        token: async (grant) =>
          grant === 'watch' ?
            (await client.accessTokens.create({ permissions: [`${platform}:${id}:watch`], ttlSeconds: 300 }))
              .token
          : token,
      };
    },
  });
  const release = async (item: Running) => {
    clearInterval(item.heartbeat);
    item.runtime?.client.disconnect();
    await hub.releaseDevice(item.session.id);
    live.delete(item.session.id);
  };
  const remove = async (item: Running) => {
    // Failed deletion stays tracked so a retry cannot exceed the concurrency limit.
    await destroy(item.session.platform, item.session.id);
    await release(item);
  };
  const stop = async () => {
    for (const item of live.values()) {
      try {
        await remove(item);
      } catch (error) {
        options.onError('delete', item.session.id, error);
      }
    }
    return [...live.values()].map((item) => item.session);
  };
  const recover = async () => {
    if (closed) throw new Error('Device host closed');
    if (recovered) return;
    const params = {
      labelSelector: `${options.owner.label}=${options.owner.value}`,
      state: 'creating,assigned,ready',
    };
    for (const platform of ['ios', 'android'] as const) {
      const pages =
        platform === 'ios' ? client.iosInstances.list(params) : client.androidInstances.list(params);
      for await (const instance of pages) await destroy(platform, instance.metadata.id);
    }
    recovered = true;
  };
  const runtime = async (item: Running) => {
    if (!item.runtime) {
      const { platform, instance } = item.session;
      const access = {
        apiUrl: instance.status.apiUrl!,
        token: instance.status.token!,
        logLevel: 'none' as const,
      };
      item.runtime =
        platform === 'ios' ?
          { platform, client: await createIosClient(access) }
        : { platform, client: await createAndroidClient(access) };
    }
    return item.runtime;
  };
  return {
    origin: hub.origin,
    headers: hub.headers,
    list: () =>
      serial(async () => {
        await recover();
        for (const item of live.values()) {
          let instance;
          try {
            instance = await get(item.session.platform, item.session.id);
          } catch (error) {
            if (!(error instanceof Limrun.APIError) || error.status !== 404) throw error;
          }
          if (!instance || instance.status.state === 'terminated') await release(item);
          else item.session.instance = instance;
        }
        return [...live.values()].map((item) => item.session);
      }),
    open: (target: DeviceHostTarget, signal?: AbortSignal) =>
      serial(async () => {
        await recover();
        signal?.throwIfAborted();
        if (pending && (pending.platform !== target.platform || pending.model !== target.model))
          throw new Error('Retry the previous device first; its allocation could not be confirmed.');
        if (live.size >= options.maxConcurrentSessions)
          throw new Error('Close a device before opening another.');
        const slot = pending?.slot ?? randomUUID();
        pending = { ...target, slot };
        const params = {
          wait: false,
          reuseIfExists: true,
          metadata: {
            displayName: options.displayName,
            labels: { [options.owner.label]: options.owner.value, [options.allocationLabel]: slot },
          },
          spec: {
            ...(options.region ? { region: options.region } : {}),
            hardTimeout: options.hardTimeout,
            inactivityTimeout: options.inactivityTimeout,
          },
        };
        let instance;
        try {
          instance =
            target.platform === 'ios' ?
              await client.iosInstances.create(
                { ...params, spec: { ...params.spec, model: target.model } },
                { signal },
              )
            : await client.androidInstances.create(
                { ...params, spec: { ...params.spec, model: target.model } },
                { signal },
              );
        } catch (error) {
          if (
            error instanceof Limrun.APIError &&
            error.status &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
          )
            pending = undefined;
          throw error;
        }
        const session: DeviceHostSession = {
          ...target,
          id: instance.metadata.id,
          slot,
          instance,
          agentEnv: {},
        };
        const item: Running = { session };
        live.set(session.id, item);
        pending = undefined;
        try {
          const timeout = AbortSignal.timeout(5 * 60_000);
          const readySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          while (session.instance.status.state !== 'ready') {
            if (session.instance.status.state === 'terminated') throw new Error('Device failed to start.');
            await delay(1000, undefined, { signal: readySignal });
            session.instance = await get(target.platform, session.id, readySignal);
          }
          readySignal.throwIfAborted();
          const status = session.instance.status;
          if (!status.token || !status.apiUrl || !status.endpointWebSocketUrl)
            throw new Error('The API key needs full control of devices.');
          if (target.platform === 'ios') {
            session.agentEnv = { LIM_IOS_INSTANCE_URL: status.apiUrl, LIM_IOS_INSTANCE_TOKEN: status.token };
          } else {
            if (!('adbWebSocketUrl' in status) || !status.adbWebSocketUrl)
              throw new Error('Device has no ADB endpoint.');
            session.agentEnv = {
              LIM_ANDROID_INSTANCE_URL: status.apiUrl,
              LIM_ANDROID_INSTANCE_TOKEN: status.token,
              LIM_ANDROID_INSTANCE_ADB_URL: status.adbWebSocketUrl,
            };
          }
          const connected = await runtime(item);
          readySignal.throwIfAborted();
          item.heartbeat = setInterval(() => connected.client.keepAlive(), 30_000);
          item.heartbeat.unref();
          return session;
        } catch (error) {
          try {
            await remove(item);
          } catch (cleanupError) {
            options.onError('delete', session.id, cleanupError);
          }
          throw error;
        }
      }),
    remove: (id: string) =>
      serial(async () => {
        const item = live.get(id);
        if (item) await remove(item);
      }),
    screenshot: (id: string) =>
      serial(async (): Promise<Uint8Array> => {
        const item = owned(id);
        const connected = await runtime(item);
        let base64;
        if (connected.platform === 'android')
          base64 = (await connected.client.screenshot()).dataUri.split(',')[1]!;
        else if (item.session.model === 'iphone-duo') {
          const fold = await connected.client.getFoldState();
          const active = fold?.displays.filter((display) => display.active) ?? [];
          const display = active.length === 1 ? active[0]!.id : 'outer';
          base64 = (await connected.client.screenshotDisplay(display, { format: 'png' })).base64;
        } else base64 = (await connected.client.screenshot({ format: 'png' })).base64;
        return new Uint8Array(Buffer.from(base64, 'base64'));
      }),
    run: (command: string, args: readonly string[], input?: { stdin?: string }) =>
      serial(async () => {
        const platform =
          command === 'xcrun' && args[0] === 'simctl' && args[1] ? 'ios'
          : command === 'adb' && args[0] === '-s' ? 'android'
          : undefined;
        const id =
          platform === 'ios' ? args[2]
          : platform === 'android' ? args[1]
          : undefined;
        const unsupported = { stdout: '', stderr: 'This command is unavailable on Limrun.', code: 127 };
        if (!id || !platform) return unsupported;
        const item = owned(id);
        if (item.session.platform !== platform) return unsupported;
        const connected = await runtime(item);
        if (connected.platform === 'ios') {
          const execution = connected.client.simctl([args[1]!, 'booted', ...args.slice(3)], input ?? {});
          const result = await execution.wait();
          return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.code };
        }
        if (connected.platform === 'android') {
          if (args[2] === 'shell') {
            const result = await connected.client.adbShell('sh', ['-c', args.slice(3).join(' ')]);
            return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
          }
          if (args[2] === 'emu' && args[3] === 'geo' && args[4] === 'fix') {
            const longitude = Number(args[5]);
            const latitude = Number(args[6]);
            if (
              args.length !== 7 ||
              !args[5]?.trim() ||
              !args[6]?.trim() ||
              !Number.isFinite(longitude) ||
              Math.abs(longitude) > 180 ||
              !Number.isFinite(latitude) ||
              Math.abs(latitude) > 90
            )
              return { stdout: '', stderr: 'Invalid location coordinates.', code: 1 };
            // Cloud Android has ADB shell access, but no local emulator console for `adb emu`.
            const commands = [
              ['appops', 'set', 'com.android.shell', 'android:mock_location', 'allow'],
              [
                'cmd',
                'location',
                'providers',
                'add-test-provider',
                'gps',
                '--requiresSatellite',
                '--supportsAltitude',
                '--supportsSpeed',
                '--supportsBearing',
              ],
              ['cmd', 'location', 'providers', 'set-test-provider-enabled', 'gps', 'true'],
              [
                'cmd',
                'location',
                'providers',
                'set-test-provider-location',
                'gps',
                '--location',
                `${latitude},${longitude}`,
                '--accuracy',
                '1',
              ],
            ];
            for (const [command, ...parameters] of commands) {
              const result = await connected.client.adbShell(command!, parameters);
              if (result.exitCode !== 0)
                return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
            }
            return { stdout: '', stderr: '', code: 0 };
          }
        }
        return unsupported;
      }),
    stop: () => serial(stop),
    close: () =>
      serial(async () => {
        if (closed) return;
        closed = true;
        try {
          await stop();
          for (const item of live.values()) await release(item);
        } finally {
          await hub.close();
        }
      }),
  };
}
