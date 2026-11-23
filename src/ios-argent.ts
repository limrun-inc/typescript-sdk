import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import os from 'os';
import path from 'path';
import { WebSocketServer } from 'ws';

import type { DeviceInfo, ElementTree, ElementTreeNode, InstanceClient, PerformAction } from './ios-client';

/**
 * Mechanisms the provider descriptor grants Argent on the simulator. Each one
 * is served by the bridge instead of a process on a local Mac.
 */
export const ARGENT_PROVIDER_CAPABILITIES = ['simulator-server', 'simctl', 'ax-service'] as const;

export type ArgentBridgeClient = Pick<
  InstanceClient,
  | 'deviceInfo'
  | 'getDeviceInfo'
  | 'listApps'
  | 'simctl'
  | 'syncApp'
  | 'screenshot'
  | 'elementTree'
  | 'performActions'
  | 'setOrientation'
  | 'setElementValue'
>;

export type ArgentBridge = {
  /** The id Argent lists the simulator under; pass it as `--udid` to Argent tools. */
  deviceId: string;
  /** The provider descriptor Argent discovers the simulator from. */
  descriptorPath: string;
  /** Environment overrides for the Argent tool-server process; merge over process.env. */
  env: Record<string, string>;
  /** Stops the bridge and withdraws the simulator from Argent. */
  close: () => Promise<void>;
};

export type ArgentBridgeOptions = {
  /** Directory Argent scans for provider descriptors. Defaults to `~/.argent/providers`. */
  providersDir?: string;
};

/**
 * Offer this instance's simulator to a locally installed Argent through its
 * device-provider contract.
 *
 * Argent expects a simulator on the same Mac: it runs `xcrun simctl`, attaches
 * to a local simulator-server for input and screenshots, and spawns an
 * accessibility daemon inside the simulator. The bridge stands in for all
 * three, so an unmodified Argent drives the remote simulator:
 *
 * - a provider descriptor points Argent at a local HTTP and WebSocket server
 *   that speaks the simulator-server protocol,
 * - an `xcrun` executable for PATH forwards simctl calls for this simulator,
 * - the same executable answers the accessibility daemon's requests when
 *   Argent spawns it.
 *
 * The Argent tool-server must start with the returned `env`, because it
 * resolves `xcrun` from its own PATH.
 */
export async function startArgentBridge(
  client: ArgentBridgeClient,
  options: ArgentBridgeOptions = {},
): Promise<ArgentBridge> {
  const udid = client.deviceInfo.udid;
  const providerId = `limrun-${udid.slice(0, 8).toLowerCase()}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-argent-'));
  const mediaDir = path.join(workDir, 'media');
  fs.mkdirSync(mediaDir);

  const session = new BridgeSession(client, mediaDir);
  const server = http.createServer((req, res) => void session.handleHttp(req, res));
  const sockets = new WebSocketServer({ server, path: '/ws' });
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      void session.handleCommand(raw.toString()).then((reply) => socket.send(JSON.stringify(reply)));
    });
  });

  const cleanup = async (descriptorPath?: string) => {
    if (descriptorPath) fs.rmSync(descriptorPath, { force: true });
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(workDir, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start the Argent bridge server.');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    session.baseUrl = baseUrl;

    const shimDir = path.join(workDir, 'bin');
    fs.mkdirSync(shimDir);
    const shimPath = path.join(shimDir, 'xcrun');
    fs.writeFileSync(shimPath, xcrunShimSource({ baseUrl, device: simctlDevice(client.deviceInfo) }), 'utf8');
    fs.chmodSync(shimPath, 0o755);

    const providersDir = options.providersDir ?? path.join(os.homedir(), '.argent', 'providers');
    fs.mkdirSync(providersDir, { recursive: true });
    const descriptorPath = path.join(providersDir, `${providerId}.json`);
    fs.writeFileSync(
      descriptorPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: providerId,
          name: 'Limrun',
          // Lets `argent providers prune` drop the descriptor if this process dies.
          pid: process.pid,
          supportUrl: 'https://docs.limrun.com',
          devices: [
            {
              nativeId: udid,
              platform: 'ios',
              kind: 'simulator',
              name: client.deviceInfo.model,
              state: 'Booted',
              capabilities: ARGENT_PROVIDER_CAPABILITIES,
              // The contract requires streamUrl. The bridge serves no video stream.
              simulatorServer: { apiUrl: baseUrl, streamUrl: `${baseUrl}/stream.mjpeg` },
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    return {
      deviceId: `ext:${providerId}:${udid}`,
      descriptorPath,
      env: { PATH: `${shimDir}${path.delimiter}${process.env['PATH'] ?? ''}` },
      close: () => cleanup(descriptorPath),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

type CommandReply = { id?: string; status: 'ok' | 'error'; message?: string };
type SimctlResult = { code: number; stdout: string; stderr: string };

/** Keeps this many screenshots on disk; Argent reads each one right after the call. */
const MEDIA_FILES_KEPT = 32;

class BridgeSession {
  baseUrl = '';
  private info: DeviceInfo;
  private gesture: { actions: PerformAction[]; last: number } | undefined;
  private queue: QueuedInput[] = [];
  private draining: Promise<void> | undefined;
  private deferredError: Error | undefined;
  private mediaFiles: string[] = [];

  constructor(
    private client: ArgentBridgeClient,
    private mediaDir: string,
  ) {
    this.info = client.deviceInfo;
  }

  // ---- input ---------------------------------------------------------------

  /**
   * Runs actions in arrival order. Actions that arrive while a batch is on the
   * wire go out together in the next one, so a typed word costs a few round
   * trips instead of two per character.
   */
  private enqueue(actions: PerformAction[]): Promise<void> {
    const done = new Promise<void>((resolve, reject) => this.queue.push({ actions, resolve, reject }));
    this.draining ??= this.drain();
    return done;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0);
      try {
        await this.client.performActions(batch.flatMap((entry) => entry.actions));
        batch.forEach((entry) => entry.resolve());
      } catch (error) {
        batch.forEach((entry) => entry.reject(asError(error)));
      }
    }
    this.draining = undefined;
  }

  /**
   * Keys and buttons are acknowledged before they reach the simulator, to keep
   * Argent's own typing pace. A failure is reported on the next call instead.
   */
  private enqueueUnacknowledged(actions: PerformAction[]): void {
    this.enqueue(actions).catch((error: Error) => {
      this.deferredError = error;
    });
  }

  /** Reads wait for pending input, so a screenshot never overtakes a tap. */
  private async settled(): Promise<void> {
    while (this.draining) await this.draining;
    const error = this.deferredError;
    this.deferredError = undefined;
    if (error) throw error;
  }

  private screen(): { width: number; height: number } {
    return {
      width: this.info.displayWidth ?? this.info.screenWidth,
      height: this.info.displayHeight ?? this.info.screenHeight,
    };
  }

  private touch(type: 'touchDown' | 'touchMove' | 'touchUp', cmd: Record<string, unknown>): PerformAction {
    const { width, height } = this.screen();
    const action = { type, x: Number(cmd['x']) * width, y: Number(cmd['y']) * height };
    const secondX = cmd['second_x'];
    const secondY = cmd['second_y'];
    if (typeof secondX === 'number' && typeof secondY === 'number') {
      return { ...action, x2: secondX * width, y2: secondY * height };
    }
    return action;
  }

  /** One simulator-server WebSocket command. Argent sends coordinates as 0..1 fractions. */
  async handleCommand(raw: string): Promise<CommandReply> {
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { status: 'error', message: 'parse error: invalid JSON' };
    }
    try {
      await this.runCommand(cmd);
      return { id: String(cmd['id']), status: 'ok' };
    } catch (error) {
      // simulator-server omits the id on a rejected command, and Argent matches on that.
      return { status: 'error', message: asError(error).message };
    }
  }

  private async runCommand(cmd: Record<string, unknown>): Promise<void> {
    const pressed = cmd['direction'] === 'Down';
    switch (cmd['cmd']) {
      case 'touch':
      case 'edgeTouch': {
        const now = Date.now();
        if (cmd['type'] === 'Down') {
          this.gesture = { actions: [this.touch('touchDown', cmd)], last: now };
          return;
        }
        const gesture = this.gesture;
        if (!gesture) throw new Error(`touch ${String(cmd['type'])} arrived without a Down`);
        // Argent paces a gesture by when it sends each event; replay that pace.
        if (now > gesture.last) gesture.actions.push({ type: 'wait', durationMs: now - gesture.last });
        gesture.last = now;
        if (cmd['type'] === 'Move') {
          gesture.actions.push(this.touch('touchMove', cmd));
          return;
        }
        gesture.actions.push(this.touch('touchUp', cmd));
        this.gesture = undefined;
        // The whole gesture goes out as one batch, and only its Up waits for it.
        await this.enqueue(gesture.actions);
        return;
      }
      case 'key':
        // Argent sends USB HID keyboard usages, which is HID usage page 7.
        this.enqueueUnacknowledged([
          { type: pressed ? 'usageDown' : 'usageUp', usagePage: 7, usage: Number(cmd['code']) },
        ]);
        return;
      case 'button': {
        const button = ARGENT_BUTTONS[String(cmd['button'])];
        if (!button) throw new Error(`button ${String(cmd['button'])} is not supported on Limrun simulators`);
        this.enqueueUnacknowledged([{ type: pressed ? 'buttonDown' : 'buttonUp', button }]);
        return;
      }
      case 'rotate':
        await this.settled();
        await this.client.setOrientation(cmd['direction'] as Parameters<InstanceClient['setOrientation']>[0]);
        this.info = await this.client.getDeviceInfo();
        return;
      case 'capture_on_demand':
        return;
      default:
        throw new Error(`parse error: unknown variant \`${String(cmd['cmd'])}\``);
    }
  }

  // ---- http ----------------------------------------------------------------

  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    try {
      if (req.method === 'GET' && url.startsWith('/media/')) {
        // Serve only screenshots this bridge wrote and still keeps; anything
        // else, a deleted screenshot included, is not found.
        const name = url.slice('/media/'.length);
        const file = this.mediaFiles.find((kept) => path.basename(kept) === name);
        let image: Buffer;
        try {
          if (!file) throw new Error('not kept');
          image = await fs.promises.readFile(file);
        } catch {
          return sendJson(res, 404, { error: 'not found' });
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length });
        res.end(image);
        return;
      }
      // Argent probes apiUrl to check that the provider is alive.
      if (req.method === 'GET' && url === '/') return sendJson(res, 200, { status: 'ok' });
      if (req.method !== 'POST') return sendJson(res, 404, { error: 'not found' });

      const body = (await readJson(req)) as Record<string, unknown>;
      if (url === '/api/screenshot') return sendJson(res, 200, await this.screenshot(body));
      if (url === '/api/pointer') return sendJson(res, 200, { status: 'ok' });
      if (url === '/api/clipboard/text') {
        await this.settled();
        const copied = await this.client
          .simctl(['pbcopy', this.info.udid], { stdin: String(body['text'] ?? '') })
          .wait();
        return sendJson(res, 200, copied.code === 0 ? { status: 'ok' } : { error: copied.stderr });
      }
      if (url === '/xcrun') return sendJson(res, 200, await this.simctl((body['args'] as string[]) ?? []));
      if (url === '/ax') {
        return sendJson(res, 200, await this.accessibilityReply(String(body['command']), body['params']));
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      const message = asError(error).message;
      // One body serves both callers: Argent reads `error`, the xcrun shim reads the rest.
      sendJson(res, 200, { error: message, code: 1, stdout: '', stderr: `limrun: ${message}\n` });
    }
  }

  private async screenshot(body: Record<string, unknown>): Promise<{ url: string; path: string }> {
    await this.settled();
    // Argent omits `scale` only when it wants native pixels. Every smaller
    // scale gets the point-sized image, the nearest size the simulator serves.
    const data = await this.client.screenshot({
      format: 'png',
      size: body['scale'] === undefined ? 'full' : 'scaled',
    });
    const name = `screenshot-${Date.now()}-${this.mediaFiles.length}.png`;
    const file = path.join(this.mediaDir, name);
    fs.writeFileSync(file, Buffer.from(data.base64, 'base64'));
    this.mediaFiles.push(file);
    while (this.mediaFiles.length > MEDIA_FILES_KEPT) {
      fs.rmSync(this.mediaFiles.shift()!, { force: true });
    }
    return { url: `${this.baseUrl}/media/${name}`, path: file };
  }

  // ---- simctl --------------------------------------------------------------

  /** A simctl call for this simulator, as the xcrun shim forwards it (without `xcrun simctl`). */
  private async simctl(args: string[]): Promise<SimctlResult> {
    const udid = this.info.udid;
    const command = args[0];
    const rest = args.slice(args.indexOf(udid) + 1);

    if (command === 'spawn') {
      // Argent reads this flag to decide whether accessibility is degraded. It
      // describes Argent's own daemon, which does not run here.
      if (rest.join(' ') === 'defaults read com.apple.Accessibility IgnoreAXServerEntitlements') {
        return { code: 0, stdout: '1\n', stderr: '' };
      }
      if (rest[0] === 'launchctl' && rest[1] === 'list') {
        // Argent parses running apps out of `launchctl list`, which the
        // simulator does not let callers run.
        const running = (await this.client.listApps()).filter((app) => app.pid !== undefined);
        const lines = running.map(
          (app) => `${app.pid}\t0\tUIKitApplication:${app.bundleId}[0000][rb-legacy]`,
        );
        return { code: 0, stdout: ['PID\tStatus\tLabel', ...lines].join('\n') + '\n', stderr: '' };
      }
    }
    await this.settled();
    if (command === 'bootstatus') return { code: 0, stdout: '', stderr: '' };
    if (command === 'install') {
      const appPath = rest[0];
      if (!appPath) return { code: 64, stdout: '', stderr: 'simctl install requires a local .app path.\n' };
      await this.client.syncApp(appPath, { install: true, launchMode: 'None', watch: false });
      return { code: 0, stdout: '', stderr: '' };
    }
    return await this.client.simctl(args).wait();
  }

  // ---- accessibility -------------------------------------------------------

  /** The reply to one accessibility daemon request, as `{result}` or `{error}`. */
  private async accessibilityReply(
    command: string,
    params: unknown,
  ): Promise<{ result: unknown } | { error: string }> {
    try {
      await this.settled();
      return { result: await this.accessibility(command, (params ?? {}) as Record<string, unknown>) };
    } catch (error) {
      return { error: asError(error).message };
    }
  }

  private async accessibility(command: string, params: Record<string, unknown>): Promise<unknown> {
    if (command === 'ping') return { status: 'ok' };
    if (command === 'live_panel') return { displayId: null };
    if (command === 'orientation') {
      this.info = await this.client.getDeviceInfo();
      return { interfaceOrientation: this.info.orientation ?? 'portrait', screenFrame: this.screen() };
    }
    if (command === 'fill' && params['check'] !== true) {
      // Without a selector the simulator resolves the focused field itself.
      try {
        await this.client.setElementValue(String(params['text'] ?? ''));
      } catch {
        throw new Error('no_focused_field');
      }
      return { verified: true };
    }

    if (!TREE_COMMANDS.has(command)) {
      // Argent treats this code as "the daemon predates the command" and
      // probes with it, so answer before reading the tree.
      throw new Error('unknown_command');
    }
    const tree = await this.client.elementTree(undefined, { visibleOnly: true });
    const screen = this.screen();
    const base = {
      alertVisible: someNode(tree, (node) => node.type === 'Alert' || node.type === 'Sheet'),
      screenFrame: screen,
      interfaceOrientation: this.info.orientation ?? 'portrait',
    };
    switch (command) {
      case 'alert_check':
        return { alertVisible: base.alertVisible };
      case 'fill':
        return { verified: someNode(tree, (node) => node.AXValue === params['text']) };
      case 'foreground_app':
        return { alertVisible: base.alertVisible, ...(await this.foregroundApp(tree)) };
      case 'describe':
        return { ...base, elements: toArgentElements(tree, screen) };
      case 'tree': {
        const app = await this.foregroundApp(tree);
        return {
          ...base,
          nodes: toArgentTreeNodes(tree, screen, app.bundleId),
          truncated: false,
          ...(app.bundleId ? { foregroundApp: app.bundleId } : {}),
          treeVersion: 1,
        };
      }
      default:
        throw new Error('unknown_command');
    }
  }

  private async foregroundApp(tree: ElementTree): Promise<{ bundleId?: string; name?: string }> {
    const root = tree[0];
    if (!root) return {};
    const apps = await this.client.listApps();
    const app = apps.find((candidate) => candidate.pid === root.pid);
    const name = root.AXLabel ?? app?.name;
    return { ...(app ? { bundleId: app.bundleId } : {}), ...(name ? { name } : {}) };
  }
}

/** The accessibility commands answered from the element tree. */
const TREE_COMMANDS = new Set(['alert_check', 'fill', 'foreground_app', 'describe', 'tree']);

type QueuedInput = { actions: PerformAction[]; resolve: () => void; reject: (error: Error) => void };

const ARGENT_BUTTONS: Record<string, string> = {
  home: 'home',
  power: 'lock',
  volumeUp: 'volumeUp',
  volumeDown: 'volumeDown',
};

// Argent derives an element's role from these trait names.
const TRAIT_BY_TYPE: Record<string, string> = {
  Button: 'button',
  Cell: 'button',
  Switch: 'button',
  StaticText: 'staticText',
  Heading: 'header',
  Link: 'link',
  Image: 'image',
  TextField: 'textEntry',
  SecureTextField: 'textEntry',
  TextView: 'textEntry',
  SearchField: 'searchField',
  TabBar: 'tabBar',
  Slider: 'adjustable',
};

const CONTAINER_TYPES = new Set([
  'Application',
  'Window',
  'Group',
  'Other',
  'ScrollView',
  'Table',
  'CollectionView',
]);

type ArgentElement = {
  label?: string;
  hint?: string;
  frame: { x: number; y: number; width: number; height: number };
  traits: string[];
  value?: string;
  identifier?: string;
};

type Screen = { width: number; height: number };

/** The node's fields in Argent's shape, with the frame left out when it is empty. */
function toArgentFields(
  node: ElementTreeNode,
  screen: Screen,
): Omit<ArgentElement, 'frame'> & {
  frame?: ArgentElement['frame'];
} {
  const { x, y, width, height } = node.frame;
  const traits = new Set(node.traits.map((trait) => trait.charAt(0).toLowerCase() + trait.slice(1)));
  const fromType = TRAIT_BY_TYPE[node.type];
  if (fromType) traits.add(fromType);
  if (!node.enabled) traits.add('notEnabled');
  const label = node.AXLabel ?? node.title;
  return {
    ...(label ? { label } : {}),
    ...(node.help ? { hint: node.help } : {}),
    // Argent expects frames as fractions of the screen. It treats a node without
    // a frame as unframed, but hides a 0x0 frame together with its subtree.
    ...(width > 0 && height > 0 ?
      {
        frame: {
          x: x / screen.width,
          y: y / screen.height,
          width: width / screen.width,
          height: height / screen.height,
        },
      }
    : {}),
    traits: [...traits],
    ...(node.AXValue ? { value: node.AXValue } : {}),
    ...(node.AXUniqueId ? { identifier: node.AXUniqueId } : {}),
  };
}

/** One `describe` element; describe has no use for an element without a frame. */
function toArgentElement(node: ElementTreeNode, screen: Screen): ArgentElement | undefined {
  const fields = toArgentFields(node, screen);
  return fields.frame ? { ...fields, frame: fields.frame } : undefined;
}

/** The flat element list behind Argent's `describe`: every node except unnamed containers. */
export function toArgentElements(tree: ElementTree, screen: Screen): ArgentElement[] {
  const elements: ArgentElement[] = [];
  const visit = (nodes: ElementTreeNode[]) => {
    for (const node of nodes) {
      const named = node.AXLabel || node.AXValue || node.title || node.AXUniqueId;
      const element = CONTAINER_TYPES.has(node.type) && !named ? undefined : toArgentElement(node, screen);
      if (element) elements.push(element);
      visit(node.children ?? []);
    }
  };
  visit(tree);
  return elements;
}

/** The nested tree behind Argent's `ui-tree`, in document order with parent links. */
export function toArgentTreeNodes(
  tree: ElementTree,
  screen: Screen,
  rootBundleId: string | undefined,
): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (children: ElementTreeNode[], parentIndex: number | undefined) => {
    for (const node of children) {
      const index = nodes.length;
      nodes.push({
        index,
        ...(parentIndex === undefined ?
          rootBundleId ? { bundleId: rootBundleId }
          : {}
        : { parentIndex }),
        ...toArgentFields(node, screen),
        roleDescription: node.role_description,
      });
      visit(node.children ?? [], index);
    }
  };
  visit(tree, undefined);
  return nodes;
}

function someNode(tree: ElementTreeNode[], matches: (node: ElementTreeNode) => boolean): boolean {
  return tree.some((node) => matches(node) || someNode(node.children ?? [], matches));
}

type SimctlDevice = { runtime: string; entry: Record<string, unknown> };

/** This simulator as an entry of `xcrun simctl list devices --json`. */
function simctlDevice(info: DeviceInfo): SimctlDevice {
  const version = (info.osVersion ?? '26.0').replace(/\./g, '-');
  return {
    runtime: `com.apple.CoreSimulator.SimRuntime.iOS-${version}`,
    entry: {
      udid: info.udid,
      name: info.model,
      state: 'Booted',
      isAvailable: true,
      deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${info.model.replace(
        /[^A-Za-z0-9]+/g,
        '-',
      )}`,
    },
  };
}

// Argent execs this for every simctl call. It handles this simulator and hands
// every other call to the real xcrun, so local simulators and devices keep
// working beside the remote one. The Go SDK embeds the same script as
// websocket/ios/shim/argent-xcrun.js; keep the two identical.
const ARGENT_XCRUN_SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const bridgeUrl = process.env.LIMRUN_ARGENT_BRIDGE_URL;
const device = JSON.parse(process.env.LIMRUN_ARGENT_DEVICE || 'null');
const udid = device.entry.udid;
const realXcrun = process.env.LIMRUN_REAL_XCRUN || '/usr/bin/xcrun';
const hasRealXcrun = fs.existsSync(realXcrun);
const args = process.argv.slice(2);

function delegate() {
  if (!hasRealXcrun) {
    process.stderr.write('limrun xcrun shim: unsupported without Xcode: xcrun ' + args.join(' ') + '\\n');
    process.exit(127);
  }
  const result = spawnSync(realXcrun, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function post(route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(bridgeUrl + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// \\\`simctl list devices --json\\\`: the local simulators plus the remote one.
function listDevices() {
  let listing = { devices: {} };
  if (hasRealXcrun) {
    const real = spawnSync(realXcrun, args, { encoding: 'utf8' });
    try {
      listing = JSON.parse(real.stdout);
    } catch {}
  }
  listing.devices = listing.devices || {};
  listing.devices[device.runtime] = [...(listing.devices[device.runtime] || []), device.entry];
  process.stdout.write(JSON.stringify(listing) + '\\n');
  process.exit(0);
}

// Argent listens on a socket and spawns its accessibility daemon, which dials
// in. This process takes the daemon's place and answers from the bridge.
function accessibilityDaemon(endpoint) {
  const socket = net.connect(endpoint);
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let end;
    while ((end = buffered.indexOf('\\n')) >= 0) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      const { id, command, params } = JSON.parse(line);
      post('/ax', { command, params })
        .catch((error) => ({ error: String(error.message || error) }))
        .then((reply) => socket.write(JSON.stringify({ id, ...reply }) + '\\n'));
    }
  });
  socket.on('close', () => process.exit(0));
  socket.on('error', (error) => {
    process.stderr.write('limrun xcrun shim: ' + error.message + '\\n');
    process.exit(1);
  });
}

function main() {
  if (args[0] !== 'simctl') return delegate();
  // Argent scopes simctl to a device set; the remote simulator has none here.
  const simctlArgs = args[1] === '--set' ? args.slice(3) : args.slice(1);
  const command = simctlArgs[0];
  const wantsJson = simctlArgs.includes('--json') || simctlArgs.includes('-j');
  if (command === 'list' && simctlArgs[1] === 'devices' && wantsJson) return listDevices();
  if (!simctlArgs.includes(udid)) return delegate();

  if (command === 'spawn' && /(^|\\/)ax-service$/.test(simctlArgs[2] || '')) {
    const socketAt = simctlArgs.indexOf('--socket');
    const portAt = simctlArgs.indexOf('--port');
    if (socketAt > 0) return accessibilityDaemon({ path: simctlArgs[socketAt + 1] });
    if (portAt > 0) return accessibilityDaemon({ host: '127.0.0.1', port: Number(simctlArgs[portAt + 1]) });
  }
  post('/xcrun', { args: simctlArgs }).then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(typeof result.code === 'number' ? result.code : 1);
  }, (error) => {
    process.stderr.write('limrun xcrun shim: ' + error.message + '\\n');
    process.exit(1);
  });
}

main();
`;

function xcrunShimSource(options: { baseUrl: string; device: SimctlDevice }): string {
  return ARGENT_XCRUN_SHIM.replace(
    'const bridgeUrl = process.env.LIMRUN_ARGENT_BRIDGE_URL;',
    `const bridgeUrl = ${JSON.stringify(options.baseUrl)};`,
  ).replace(
    "const device = JSON.parse(process.env.LIMRUN_ARGENT_DEVICE || 'null');",
    `const device = ${JSON.stringify(options.device)};`,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
