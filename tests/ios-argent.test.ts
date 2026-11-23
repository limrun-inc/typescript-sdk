import { execFile, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { WebSocket } from 'ws';
import {
  startArgentBridge,
  toArgentElements,
  toArgentTreeNodes,
  type ArgentBridge,
} from '@limrun/api/ios-argent';
import type { ElementTreeNode, PerformAction } from '@limrun/api/ios-client';

const UDID = 'A1B2C3D4-0000-4000-8000-000000000001';
// A 1x1 PNG, so the screenshot the bridge writes is a real image file.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function node(overrides: Partial<ElementTreeNode>): ElementTreeNode {
  return {
    AXFrame: '',
    content_required: false,
    custom_actions: [],
    enabled: true,
    frame: { x: 0, y: 0, width: 400, height: 800 },
    pid: 77,
    role: 'AXGroup',
    role_description: 'group',
    traits: [],
    type: 'Group',
    ...overrides,
  };
}

const settingsTree: ElementTreeNode[] = [
  node({
    type: 'Application',
    AXLabel: 'Settings',
    children: [
      node({
        type: 'Other',
        children: [
          node({
            type: 'Button',
            AXLabel: 'General',
            AXUniqueId: 'general-cell',
            frame: { x: 100, y: 200, width: 200, height: 80 },
          }),
          node({
            type: 'TextField',
            AXLabel: 'Search',
            AXValue: 'wifi',
            enabled: false,
            frame: { x: 0, y: 400, width: 400, height: 40 },
          }),
        ],
      }),
    ],
  }),
];

function fakeClient() {
  const calls: string[] = [];
  const performed: PerformAction[][] = [];
  const simctlCalls: string[][] = [];
  const deviceInfo = {
    udid: UDID,
    screenWidth: 400,
    screenHeight: 800,
    model: 'iPhone 16 Pro',
    osVersion: '26.4',
  };
  const client = {
    deviceInfo,
    getDeviceInfo: async () => deviceInfo,
    listApps: async () => [
      { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System', pid: 77 },
    ],
    simctl: (args: string[]) => {
      simctlCalls.push(args);
      return { wait: async () => ({ code: 0, stdout: 'simctl-ok\n', stderr: '' }) };
    },
    syncApp: async () => ({}),
    screenshot: async () => {
      calls.push('screenshot');
      return { base64: PNG_BASE64, width: 1, height: 1 };
    },
    elementTree: async () => settingsTree,
    performActions: async (actions: PerformAction[]) => {
      // Slower than the test's next request, so ordering is what gets asserted.
      await new Promise((resolve) => setTimeout(resolve, 40));
      calls.push('performActions');
      performed.push(actions);
      return { results: [] };
    },
    setOrientation: async () => {},
    setElementValue: async () => ({}),
  };
  return {
    client: client as unknown as Parameters<typeof startArgentBridge>[0],
    calls,
    performed,
    simctlCalls,
  };
}

function runShim(
  bridge: ArgentBridge,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(bridge.env['PATH']!.split(path.delimiter)[0]!, 'xcrun'), ...args],
      // No real xcrun, as on a Linux agent machine.
      { env: { ...process.env, LIMRUN_REAL_XCRUN: '/nonexistent/xcrun' }, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

function rawGetStatus(baseUrl: string, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(baseUrl);
    http
      .get({ hostname, port, path: rawPath }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

describe('Argent bridge', () => {
  let providersDir: string;
  let fake: ReturnType<typeof fakeClient>;
  let bridge: ArgentBridge;
  let apiUrl: string;

  beforeEach(async () => {
    providersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-argent-test-'));
    fake = fakeClient();
    bridge = await startArgentBridge(fake.client, { providersDir });
    apiUrl = JSON.parse(fs.readFileSync(bridge.descriptorPath, 'utf8')).devices[0].simulatorServer.apiUrl;
  });

  afterEach(async () => {
    await bridge.close();
    fs.rmSync(providersDir, { recursive: true, force: true });
  });

  async function post(route: string, body: unknown): Promise<any> {
    const response = await fetch(apiUrl + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await response.json();
  }

  async function commandSocket(): Promise<{ send: (cmd: object) => Promise<any>; close: () => void }> {
    const socket = new WebSocket(apiUrl.replace('http:', 'ws:') + '/ws');
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return {
      send: (cmd) =>
        new Promise((resolve) => {
          socket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
          socket.send(JSON.stringify(cmd));
        }),
      close: () => socket.close(),
    };
  }

  test('publishes a provider descriptor and withdraws it on close', async () => {
    const descriptor = JSON.parse(fs.readFileSync(bridge.descriptorPath, 'utf8'));
    expect(path.dirname(bridge.descriptorPath)).toBe(providersDir);
    expect(descriptor).toMatchObject({ schemaVersion: 1, id: 'limrun-a1b2c3d4', pid: process.pid });
    expect(descriptor.devices[0]).toMatchObject({
      nativeId: UDID,
      platform: 'ios',
      kind: 'simulator',
      capabilities: ['simulator-server', 'simctl', 'ax-service'],
    });
    expect(bridge.deviceId).toBe(`ext:limrun-a1b2c3d4:${UDID}`);
    // Argent drops a device whose apiUrl does not answer.
    expect((await fetch(apiUrl)).ok).toBe(true);

    await bridge.close();
    expect(fs.existsSync(bridge.descriptorPath)).toBe(false);
    bridge = await startArgentBridge(fake.client, { providersDir });
  });

  test('replays a tap as one batch in screen points and acknowledges the Up after it ran', async () => {
    const socket = await commandSocket();
    expect(await socket.send({ id: '1', cmd: 'touch', type: 'Down', x: 0.5, y: 0.25 })).toEqual({
      id: '1',
      status: 'ok',
    });
    expect(fake.performed).toHaveLength(0);
    expect(await socket.send({ id: '2', cmd: 'touch', type: 'Up', x: 0.5, y: 0.25 })).toEqual({
      id: '2',
      status: 'ok',
    });
    socket.close();

    expect(fake.performed).toHaveLength(1);
    const touches = fake.performed[0]!.filter((action) => action.type !== 'wait');
    expect(touches).toEqual([
      { type: 'touchDown', x: 200, y: 200 },
      { type: 'touchUp', x: 200, y: 200 },
    ]);
  });

  test('rejects an unknown command without an id, as simulator-server does', async () => {
    const socket = await commandSocket();
    const reply = await socket.send({ id: '9', cmd: 'teleport' });
    socket.close();
    expect(reply).toEqual({ status: 'error', message: 'parse error: unknown variant `teleport`' });
  });

  test('a screenshot waits for keys that were acknowledged early', async () => {
    const socket = await commandSocket();
    await socket.send({ id: '1', cmd: 'key', code: 4, direction: 'Down' });
    await socket.send({ id: '2', cmd: 'key', code: 4, direction: 'Up' });
    const shot = await post('/api/screenshot', { scale: 0.25 });
    socket.close();

    expect(fake.calls[fake.calls.length - 1]).toBe('screenshot');
    expect(fake.performed.flat()).toEqual([
      { type: 'usageDown', usagePage: 7, usage: 4 },
      { type: 'usageUp', usagePage: 7, usage: 4 },
    ]);
    expect(fs.readFileSync(shot.path).subarray(1, 4).toString()).toBe('PNG');
  });

  test('a stale media URL answers 404 and the bridge keeps serving', async () => {
    // Raw request paths: fetch would normalize the dot segments away.
    for (const stale of ['/media/screenshot-gone.png', '/media/..', '/media/%2e%2e']) {
      expect(await rawGetStatus(apiUrl, stale)).toBe(404);
    }
    const shot = await post('/api/screenshot', { scale: 0.25 });
    const served = await fetch(shot.url);
    expect(served.status).toBe(200);
    expect(
      Buffer.from(await served.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });

  test('an unknown accessibility command answers without reading the tree', async () => {
    let treeReads = 0;
    const elementTree = fake.client.elementTree;
    (fake.client as { elementTree: typeof elementTree }).elementTree = async (...args) => {
      treeReads++;
      return elementTree(...args);
    };
    expect(await post('/ax', { command: 'teleport' })).toEqual({ error: 'unknown_command' });
    expect(treeReads).toBe(0);
  });

  test('the xcrun shim lists the simulator and forwards its simctl calls', async () => {
    const listing = await runShim(bridge, ['simctl', 'list', 'devices', '--json']);
    expect(JSON.parse(listing.stdout).devices['com.apple.CoreSimulator.SimRuntime.iOS-26-4']).toEqual([
      expect.objectContaining({ udid: UDID, state: 'Booted', name: 'iPhone 16 Pro' }),
    ]);

    // Argent prefixes a device set when one is configured.
    const launch = await runShim(bridge, ['simctl', '--set', '/sets/a', 'launch', UDID, 'com.example.app']);
    expect(launch).toMatchObject({ code: 0, stdout: 'simctl-ok\n' });
    expect(fake.simctlCalls).toEqual([['launch', UDID, 'com.example.app']]);

    const other = await runShim(bridge, ['simctl', 'launch', 'FFFFFFFF-0000-4000-8000-000000000000', 'x']);
    expect(other.code).toBe(127);
  });

  test('the xcrun shim answers as the accessibility daemon Argent spawns', async () => {
    const socketPath = path.join(providersDir, 'ax.sock');
    const replies: any[] = [];
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const daemon = spawn(
      process.execPath,
      [
        path.join(bridge.env['PATH']!.split(path.delimiter)[0]!, 'xcrun'),
        ...['simctl', 'spawn', UDID, '/argent/bin/darwin/ax-service', '--socket', socketPath],
        ...['--timeout', '3600'],
      ],
      { stdio: 'ignore' },
    );
    try {
      const connection = await new Promise<net.Socket>((resolve) => server.once('connection', resolve));
      const twoReplies = new Promise<void>((resolve) => {
        let buffered = '';
        connection.on('data', (chunk) => {
          buffered += chunk.toString();
          const lines = buffered.split('\n');
          buffered = lines.pop()!;
          replies.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
          if (replies.length === 2) resolve();
        });
      });
      connection.write(JSON.stringify({ id: 1, command: 'describe' }) + '\n');
      connection.write(JSON.stringify({ id: 2, command: 'teleport' }) + '\n');
      await twoReplies;
      connection.destroy();
    } finally {
      daemon.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const describe = replies.find((reply) => reply.id === 1).result;
    expect(describe.screenFrame).toEqual({ width: 400, height: 800 });
    expect(describe.elements.map((element: { label: string }) => element.label)).toEqual([
      'Settings',
      'General',
      'Search',
    ]);
    expect(replies.find((reply) => reply.id === 2)).toEqual({ id: 2, error: 'unknown_command' });
  });
});

describe('toArgentTreeNodes', () => {
  test('keeps a zero-size node with its label and traits, without a frame', () => {
    const tree = [
      node({
        type: 'Other',
        AXLabel: 'Wrapper',
        frame: { x: 0, y: 0, width: 0, height: 0 },
        children: [
          node({ type: 'Button', AXLabel: 'Inside', frame: { x: 0, y: 0, width: 400, height: 80 } }),
        ],
      }),
    ];
    const nodes = toArgentTreeNodes(tree, { width: 400, height: 800 }, 'com.example.app');
    expect(nodes[0]).toEqual({
      index: 0,
      bundleId: 'com.example.app',
      label: 'Wrapper',
      traits: [],
      roleDescription: 'group',
    });
    expect(nodes[1]).toMatchObject({ index: 1, parentIndex: 0, label: 'Inside', traits: ['button'] });
    expect(nodes[1]!['frame']).toEqual({ x: 0, y: 0, width: 1, height: 0.1 });
  });
});

describe('toArgentElements', () => {
  test('maps elements to normalized frames and Argent trait names', () => {
    const elements = toArgentElements(settingsTree, { width: 400, height: 800 });
    // The unnamed "Other" container is dropped; the labelled application stays.
    expect(elements).toHaveLength(3);
    expect(elements[1]).toEqual({
      label: 'General',
      frame: { x: 0.25, y: 0.25, width: 0.5, height: 0.1 },
      traits: ['button'],
      identifier: 'general-cell',
    });
    expect(elements[2]).toMatchObject({ value: 'wifi', traits: ['textEntry', 'notEnabled'] });
  });
});
