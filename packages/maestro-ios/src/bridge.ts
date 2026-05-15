import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Ios } from '@limrun/api';
import { requireSupportedRoute, UnsupportedRouteError } from './support-matrix';
import type { ElementTreeNode, JsonRecord, MaestroTreeNode } from './types';

export type IosClient = Awaited<ReturnType<typeof Ios.createInstanceClient>>;

export type BridgeServer = {
  server: http.Server;
  url(): string;
  close(): Promise<void>;
};

export function createBridgeServer(ios: IosClient): BridgeServer {
  const state: {
    recordingPath?: string;
    tempFiles: string[];
  } = {
    tempFiles: [],
  };
  // Java's HttpClient can keep connections open; track sockets so shutdown is bounded.
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }

      const route = req.url.replace(/^\//, '');
      const body = await readJson(req);
      const result = await handleBridgeRequest(ios, state, route, body);
      sendJson(res, 200, result);
    } catch (error) {
      const status = error instanceof UnsupportedRouteError ? 501 : 500;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    url() {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Bridge server did not bind to a TCP port');
      }
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      if (state.recordingPath) {
        try {
          // The Java process may be killed before Maestro closes the recording handle.
          await ios.stopRecording({ localPath: state.recordingPath });
        } catch {
          // Best-effort cleanup for interrupted recording flows.
        } finally {
          state.recordingPath = undefined;
        }
      }
      await closeServer(server, sockets);
      cleanupTempFiles(state.tempFiles);
    },
  };
}

export async function listen(bridge: BridgeServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    bridge.server.once('error', reject);
    bridge.server.listen(0, '127.0.0.1', resolve);
  });
}

export async function handleBridgeRequest(
  ios: IosClient,
  state: { recordingPath?: string; tempFiles: string[] },
  route: string,
  body: JsonRecord,
): Promise<unknown> {
  requireSupportedRoute(route);

  switch (route) {
    case 'open':
    case 'close':
      return {};
    case 'deviceInfo':
      return {
        widthPixels: ios.deviceInfo.screenWidth,
        heightPixels: ios.deviceInfo.screenHeight,
        widthGrid: ios.deviceInfo.screenWidth,
        heightGrid: ios.deviceInfo.screenHeight,
      };
    case 'launchApp': {
      const launchArguments = optionalRecord(body, 'launchArguments');
      if (launchArguments && Object.keys(launchArguments).length > 0) {
        throw new UnsupportedRouteError('launchApp', 'launchArguments are not supported by @limrun/maestro-ios yet');
      }
      await ios.launchApp(requiredString(body, 'appId'), 'RelaunchIfRunning');
      return {};
    }
    case 'stopApp':
      await ios.terminateApp(requiredString(body, 'appId'));
      return {};
    case 'clearAppState':
      await ios.softReset(requiredString(body, 'appId'), { strategy: 'data' });
      return {};
    case 'tap':
      await ios.tap(requiredNumber(body, 'x'), requiredNumber(body, 'y'));
      return {};
    case 'longPress': {
      const x = requiredNumber(body, 'x');
      const y = requiredNumber(body, 'y');
      await ios.performActions([
        { type: 'touchDown', x, y },
        { type: 'wait', durationMs: 700 },
        { type: 'touchUp', x, y },
      ]);
      return {};
    }
    case 'pressKey':
      await ios.pressKey(mapKeyCode(requiredString(body, 'code')));
      return {};
    case 'inputText':
      await ios.typeText(requiredString(body, 'text'));
      return {};
    case 'openLink':
      await ios.openUrl(requiredString(body, 'link'));
      return {};
    case 'hideKeyboard':
      await ios.pressKey('escape');
      return {};
    case 'contentDescriptor': {
      const tree = (await ios.elementTree()) as ElementTreeNode[];
      return {
        attributes: {
          bounds: boundsString({ x: 0, y: 0, width: ios.deviceInfo.screenWidth, height: ios.deviceInfo.screenHeight }),
        },
        children: tree.map(mapTreeNode),
      };
    }
    case 'scroll':
      await ios.scroll((body['direction'] as 'up' | 'down' | 'left' | 'right') ?? 'down', numberOrDefault(body['pixels'], 400));
      return {};
    case 'swipe':
      await swipeBetween(ios, body);
      return {};
    case 'swipeDirection':
      await ios.scroll(mapSwipeDirection(String(body['direction'] ?? 'UP')), 400);
      return {};
    case 'swipeElement':
      await ios.scroll(mapSwipeDirection(String(body['direction'] ?? 'UP')), 400, {
        coordinate: [numberOrDefault(body['x'], Math.round(ios.deviceInfo.screenWidth / 2)), numberOrDefault(body['y'], Math.round(ios.deviceInfo.screenHeight / 2))],
      });
      return {};
    case 'isKeyboardVisible':
      return { visible: false };
    case 'takeScreenshot':
      return { base64: (await ios.screenshot()).base64 };
    case 'startScreenRecording':
      if (state.recordingPath) {
        throw new Error('Screen recording is already active');
      }
      state.recordingPath = path.join(os.tmpdir(), `limrun-maestro-ios-recording-${process.pid}-${Date.now()}.mp4`);
      state.tempFiles.push(state.recordingPath);
      await ios.startRecording();
      return {};
    case 'stopScreenRecording': {
      const recordingPath = state.recordingPath;
      if (!recordingPath) {
        throw new Error('Screen recording is not active');
      }
      await ios.stopRecording({ localPath: recordingPath });
      state.recordingPath = undefined;
      const base64 = fs.readFileSync(recordingPath).toString('base64');
      return { base64 };
    }
    case 'setPermissions': {
      const permissions = optionalRecord(body, 'permissions');
      if (!permissions || Object.keys(permissions).length === 0) {
        // Maestro calls setPermissions during launch even when the flow requested no changes.
        return {};
      }
      throw new UnsupportedRouteError('setPermissions', 'setPermissions is only supported for empty permission maps in this release');
    }
    case 'setOrientation':
      await ios.setOrientation(String(body['orientation']).startsWith('LANDSCAPE') ? 'Landscape' : 'Portrait');
      return {};
    case 'eraseText':
      await eraseText(ios, numberOrDefault(body['charactersToErase'], 1));
      return {};
    default:
      throw new Error(`Bridge route is listed in the support matrix but has no handler: ${route}`);
  }
}

function mapTreeNode(node: ElementTreeNode): MaestroTreeNode {
  const label = node.AXLabel ?? '';
  const title = node.title ?? '';
  const value = node.AXValue ?? '';
  const text = title || value || label;
  const attributes: Record<string, string> = {
    accessibilityText: label,
    // Maestro's `id:` selector expects a stable technical id; Limrun exposes iOS accessibilityIdentifier as AXUniqueId.
    id: node.AXUniqueId ?? '',
    accessibilityIdentifier: node.AXUniqueId ?? '',
    title,
    value,
    text,
    hintText: '',
    'resource-id': node.AXUniqueId ?? '',
    bounds: boundsString(node.frame),
    enabled: String(node.enabled ?? true),
    focused: 'false',
    selected: String(node.selected ?? false),
    class: node.type ?? node.role ?? '',
  };

  return {
    attributes,
    children: (node.children ?? []).map(mapTreeNode),
    clickable: node.traits?.some((trait) => trait.toLowerCase().includes('button')) ?? false,
    enabled: node.enabled ?? true,
    focused: false,
    selected: node.selected ?? false,
  };
}

function boundsString(frame: ElementTreeNode['frame']): string {
  if (!frame) {
    return '[0,0][0,0]';
  }
  const left = Math.round(frame.x);
  const top = Math.round(frame.y);
  const right = Math.round(frame.x + frame.width);
  const bottom = Math.round(frame.y + frame.height);
  return `[${left},${top}][${right},${bottom}]`;
}

async function swipeBetween(ios: IosClient, body: JsonRecord): Promise<void> {
  const start = requiredRecord(body, 'start');
  const end = requiredRecord(body, 'end');
  const startX = requiredNumber(start, 'x');
  const startY = requiredNumber(start, 'y');
  const endX = requiredNumber(end, 'x');
  const endY = requiredNumber(end, 'y');
  await ios.performActions([
    { type: 'touchDown', x: startX, y: startY },
    { type: 'wait', durationMs: 100 },
    { type: 'touchMove', x: endX, y: endY },
    { type: 'touchUp', x: endX, y: endY },
  ]);
}

async function eraseText(ios: IosClient, charactersToErase: number): Promise<void> {
  for (let i = 0; i < charactersToErase; i += 1) {
    await ios.pressKey('backspace');
  }
}

function mapKeyCode(code: string): string {
  const key = code.toUpperCase();
  if (key === 'BACKSPACE') {
    return 'backspace';
  }
  if (key === 'ENTER') {
    return 'enter';
  }
  if (key === 'BACK' || key === 'ESCAPE') {
    return 'escape';
  }
  return code.toLowerCase();
}

function mapSwipeDirection(direction: string): 'up' | 'down' | 'left' | 'right' {
  switch (direction.toUpperCase()) {
    case 'DOWN':
      return 'down';
    case 'LEFT':
      return 'left';
    case 'RIGHT':
      return 'right';
    default:
      return 'up';
  }
}

function readJson(req: http.IncomingMessage): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as JsonRecord) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requiredString(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new Error(`Missing string field ${key}`);
  }
  return value;
}

function requiredNumber(body: JsonRecord, key: string): number {
  const value = body[key];
  if (typeof value !== 'number') {
    throw new Error(`Missing number field ${key}`);
  }
  return value;
}

function requiredRecord(body: JsonRecord, key: string): JsonRecord {
  const value = body[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Missing object field ${key}`);
  }
  return value as JsonRecord;
}

function optionalRecord(body: JsonRecord, key: string): JsonRecord | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object field ${key}`);
  }
  return value as JsonRecord;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function closeServer(server: http.Server, sockets: Set<net.Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      for (const socket of sockets) {
        socket.destroy();
      }
    }, 2_000);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function cleanupTempFiles(paths: string[]): void {
  for (const item of paths) {
    try {
      fs.rmSync(item, { force: true });
    } catch {
      // Best-effort cleanup for transient recording downloads.
    }
  }
}
