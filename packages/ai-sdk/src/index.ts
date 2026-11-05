import Limrun, { createInstanceClient, Ios, type ClientOptions, type InstanceClient } from '@limrun/api';
import { tool } from 'ai';
import { z } from 'zod';

// Tool names, input schemas and descriptions mirror the remote MCP server at
// https://mcp.limrun.com/mcp so prompts written for one work with the other.

const iosId = z
  .string()
  .describe('ID of the iOS simulator to drive, as returned by create-ios-simulator or list-instances.');
const androidId = z
  .string()
  .describe('ID of the Android emulator to drive, as returned by create-android-emulator or list-instances.');
const anyId = z
  .string()
  .describe('Instance ID, such as one returned by create-ios-simulator or list-instances.');

const createInput = z.object({
  apps: z
    .array(z.string())
    .optional()
    .describe(
      'Apps to pre-install: existing asset names (see list-apps) or public https URLs of app archives (iOS: zip/tar.gz of a simulator .app; Android: APK).',
    ),
  inactivityTimeout: z
    .string()
    .optional()
    .describe(
      'Optional inactivity timeout as a duration string such as "3m" or "1h". The instance terminates after this long without interaction. Omit to use the organization default.',
    ),
  tunnel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional name of a private tunnel the organization runs. The app reaches the tunnel destinations, and the instance becomes ready only after the tunnel attaches.',
    ),
});

const direction = z.enum(['up', 'down', 'left', 'right']);

const iosSelector = z
  .object({
    AXUniqueId: z.string().optional().describe('Exact AXUniqueId/accessibilityIdentifier to match.'),
    AXLabel: z.string().optional().describe('Exact accessibility label to match.'),
    AXLabelContains: z.string().optional().describe('Case-insensitive substring of the accessibility label.'),
    type: z.string().optional().describe('Element type or role, such as Button or TextField.'),
    title: z.string().optional().describe('Exact title to match.'),
    titleContains: z.string().optional().describe('Case-insensitive substring of the title.'),
    AXValue: z.string().optional().describe('Exact accessibility value to match.'),
  })
  .describe('Selector for iOS accessibility elements. All supplied fields must match.');

const touch = { x: z.number(), y: z.number(), x2: z.number().optional(), y2: z.number().optional() };
const screenSize = { screenWidth: z.number().optional(), screenHeight: z.number().optional() };
const button = z.enum(['home', 'lock', 'side', 'applePay', 'softwareKeyboard']);

const iosAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    selector: iosSelector.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    ...screenSize,
  }),
  z.object({ kind: z.literal('tapElement'), selector: iosSelector }),
  z.object({ kind: z.literal('setElementValue'), selector: iosSelector, text: z.string() }),
  z.object({ kind: z.literal('incrementElement'), selector: iosSelector }),
  z.object({ kind: z.literal('decrementElement'), selector: iosSelector }),
  z.object({ kind: z.literal('type'), text: z.string(), pressEnter: z.boolean().optional() }),
  z.object({ kind: z.literal('pressKey'), key: z.string(), modifiers: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal('scroll'),
    scrollDirection: direction,
    scrollAmount: z.number().describe('Scroll distance in pixels.'),
    coordinate: z.tuple([z.number(), z.number()]).optional().describe('Start [x, y]. Defaults to center.'),
    momentum: z.number().optional().describe('0.0-1.0 controlling scroll speed and inertia.'),
  }),
  z.object({ kind: z.literal('wait'), duration: z.number().describe('Duration in milliseconds.') }),
  z.object({ kind: z.literal('toggleKeyboard') }),
  z.object({ kind: z.literal('openUrl'), url: z.string() }),
  z.object({ kind: z.literal('setOrientation'), orientation: z.enum(['Portrait', 'Landscape']) }),
  z.object({ kind: z.literal('touchDown'), ...touch, ...screenSize }),
  z.object({ kind: z.literal('touchMove'), ...touch, ...screenSize }),
  z.object({ kind: z.literal('touchUp'), ...touch, ...screenSize }),
  z.object({ kind: z.literal('keyDown'), keyCode: z.number() }),
  z.object({ kind: z.literal('keyUp'), keyCode: z.number() }),
  z.object({ kind: z.literal('buttonDown'), button }),
  z.object({ kind: z.literal('buttonUp'), button }),
]);

type IosAction = z.infer<typeof iosAction>;

/** Converts an action in the MCP shape to the SDK `performActions` shape. */
function toPerformAction(action: IosAction): Ios.PerformAction {
  switch (action.kind) {
    case 'tap': {
      const { kind, selector, x, y, ...size } = action;
      if (selector) return { type: 'tapElement', selector };
      if (x === undefined || y === undefined) throw new Error('tap needs a selector, or both x and y.');
      return { type: kind, x, y, ...size };
    }
    case 'type':
      return { type: 'typeText', text: action.text, pressEnter: action.pressEnter };
    case 'scroll':
      return {
        type: 'scroll',
        direction: action.scrollDirection,
        pixels: action.scrollAmount,
        coordinate: action.coordinate,
        momentum: action.momentum,
      };
    case 'wait':
      return { type: 'wait', durationMs: action.duration };
    case 'tapElement':
    case 'incrementElement':
    case 'decrementElement':
      return { type: action.kind, selector: action.selector };
    case 'setElementValue':
      return { type: action.kind, selector: action.selector, text: action.text };
    case 'pressKey':
      return { type: action.kind, key: action.key, modifiers: action.modifiers };
    case 'toggleKeyboard':
      return { type: action.kind };
    case 'openUrl':
      return { type: action.kind, url: action.url };
    case 'setOrientation':
      return { type: action.kind, orientation: action.orientation };
    case 'touchDown':
    case 'touchMove':
    case 'touchUp': {
      const { kind, ...rest } = action;
      return { type: kind, ...rest };
    }
    case 'keyDown':
    case 'keyUp':
      return { type: action.kind, keyCode: action.keyCode };
    case 'buttonDown':
    case 'buttonUp':
      return { type: action.kind, button: action.button };
  }
}

const androidSelector = z
  .object({
    resourceId: z.string().optional().describe('Matches the XML resource-id attribute.'),
    text: z.string().optional().describe('Matches the XML text attribute.'),
    contentDesc: z.string().optional().describe('Matches the XML content-desc attribute.'),
    className: z.string().optional().describe('Matches the XML class attribute.'),
    packageName: z.string().optional().describe('Matches the XML package attribute.'),
    index: z.number().optional().describe('Matches the XML index attribute.'),
    clickable: z.boolean().optional(),
    enabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    boundsContains: z
      .object({ x: z.number(), y: z.number() })
      .optional()
      .describe('Matches any element whose bounds contain this coordinate.'),
  })
  .describe('Selector for Android UIAutomator nodes. All supplied fields must match.');

const androidAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tap'),
    selector: androidSelector.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({
    kind: z.literal('setText'),
    text: z.string(),
    selector: androidSelector.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  z.object({ kind: z.literal('pressKey'), key: z.string(), modifiers: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('scrollScreen'), direction, amount: z.number().optional() }),
  z.object({
    kind: z.literal('scrollElement'),
    direction,
    amount: z.number().optional(),
    selector: androidSelector.optional(),
  }),
  z.object({ kind: z.literal('findElement'), selector: androidSelector, limit: z.number().optional() }),
  z.object({ kind: z.literal('openUrl'), url: z.string() }),
  z.object({ kind: z.literal('wait'), duration: z.number().describe('Duration in milliseconds.') }),
]);

type AndroidAction = z.infer<typeof androidAction>;

function runAndroidAction(client: InstanceClient, action: AndroidAction): Promise<unknown> {
  switch (action.kind) {
    case 'tap':
      return client.tap({ selector: action.selector, x: action.x, y: action.y });
    case 'setText': {
      const { kind, text, ...target } = action;
      return client.setText(target.selector || target.x !== undefined ? target : undefined, text);
    }
    case 'pressKey':
      return client.pressKey(action.key, action.modifiers);
    case 'scrollScreen':
      return client.scrollScreen(action.direction, action.amount);
    case 'scrollElement':
      return client.scrollElement({ selector: action.selector }, action.direction, action.amount);
    case 'findElement':
      return client.findElement(action.selector, action.limit);
    case 'openUrl':
      return client.openUrl(action.url);
    case 'wait':
      return new Promise((resolve) =>
        setTimeout(() => resolve({ waited: action.duration }), action.duration),
      );
  }
}

type Screenshot = { base64: string; mediaType: string };

/** Sends the screenshot to the model as an image and the rest of the output as JSON text. */
function screenshotToModel({ screenshot, ...rest }: { screenshot: Screenshot }) {
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: JSON.stringify(rest) },
      {
        type: 'file' as const,
        mediaType: screenshot.mediaType,
        data: { type: 'data' as const, data: screenshot.base64 },
      },
    ],
  };
}

async function androidScreenshot(client: InstanceClient): Promise<Screenshot> {
  const { dataUri } = await client.screenshot();
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUri);
  if (!match) throw new Error('The emulator returned a screenshot that is not a base64 data URI.');
  return { mediaType: match[1]!, base64: match[2]! };
}

function platformOf(instanceId: string): 'ios' | 'android' {
  const prefix = instanceId.split('_')[0];
  if (prefix === 'ios' || prefix === 'android') return prefix;
  throw new Error(
    `Unknown instance ID "${instanceId}". Expected an ID that starts with "ios_" or "android_".`,
  );
}

/**
 * Returns Limrun device tools for the Vercel AI SDK: create, drive and delete
 * cloud iOS simulators and Android emulators.
 *
 * @param options Options for the Limrun API client. The API key defaults to the `LIM_API_KEY` environment variable.
 */
export function limrunTools(options: ClientOptions = {}) {
  const limrun = new Limrun(options);
  const resources = (instanceId: string) =>
    platformOf(instanceId) === 'ios' ? limrun.iosInstances : limrun.androidInstances;

  async function ready(instanceId: string) {
    const { status } = await resources(instanceId).get(instanceId);
    if (status.state !== 'ready' || !status.apiUrl || !status.token) {
      throw new Error(`Instance ${instanceId} is ${status.state}, not ready.`);
    }
    return { apiUrl: status.apiUrl, token: status.token, logLevel: 'none' as const };
  }

  // ponytail: one connection per call keeps the tools stateless like the MCP server; cache clients if latency matters.
  async function withIos<T>(instanceId: string, run: (client: Ios.InstanceClient) => Promise<T>) {
    if (platformOf(instanceId) !== 'ios') throw new Error(`${instanceId} is not an iOS simulator.`);
    const client = await Ios.createInstanceClient(await ready(instanceId));
    try {
      return await run(client);
    } finally {
      client.disconnect();
    }
  }

  async function withAndroid<T>(instanceId: string, run: (client: InstanceClient) => Promise<T>) {
    if (platformOf(instanceId) !== 'android') throw new Error(`${instanceId} is not an Android emulator.`);
    const client = await createInstanceClient(await ready(instanceId));
    try {
      return await run(client);
    } finally {
      client.disconnect();
    }
  }

  const createParams = ({ apps, inactivityTimeout, tunnel }: z.infer<typeof createInput>) => ({
    wait: true,
    metadata: { labels: { 'created-by': 'ai-sdk' } },
    spec: {
      ...(inactivityTimeout && { inactivityTimeout }),
      ...(tunnel && { tunnel }),
      ...(apps?.length && {
        initialAssets: apps.map((app) =>
          /^https?:\/\//.test(app) ?
            { kind: 'App' as const, source: 'URL' as const, url: app }
          : { kind: 'App' as const, source: 'AssetName' as const, assetName: app },
        ),
      }),
    },
  });

  const summary = (instance: {
    metadata: { id: string; createdAt: string };
    status: { state: string; errorMessage?: string };
  }) => ({
    instanceId: instance.metadata.id,
    state: instance.status.state,
    createdAt: instance.metadata.createdAt,
    ...(instance.status.errorMessage && { errorMessage: instance.status.errorMessage }),
  });

  return {
    'create-ios-simulator': tool({
      description:
        'Create a cloud iOS simulator and wait until it is ready. Returns the instance ID to pass to the ios-* tools. Pre-install apps by asset name (see list-apps) or public URL. The app must be a simulator build whose ".app" folder is archived into a tar.gz or zip archive.',
      inputSchema: createInput,
      execute: async (input) => summary(await limrun.iosInstances.create(createParams(input))),
    }),

    'create-android-emulator': tool({
      description:
        'Create a cloud Android emulator and wait until it is ready. Returns the instance ID to pass to the android-* tools. Pre-install apps by asset name (see list-apps) or public APK URL.',
      inputSchema: createInput,
      execute: async (input) => summary(await limrun.androidInstances.create(createParams(input))),
    }),

    'list-instances': tool({
      description: "List the organization's running iOS simulators and Android emulators.",
      inputSchema: z.object({}),
      execute: async () => {
        const instances = [];
        for await (const i of limrun.iosInstances.list({ state: 'ready' })) instances.push(summary(i));
        for await (const i of limrun.androidInstances.list({ state: 'ready' })) instances.push(summary(i));
        return { instances };
      },
    }),

    'get-instance-status': tool({
      description: 'Get the current state of an instance by ID.',
      inputSchema: z.object({ instanceId: anyId }),
      execute: async ({ instanceId }) => summary(await resources(instanceId).get(instanceId)),
    }),

    'delete-instance': tool({
      description:
        'Delete an iOS simulator or Android emulator by ID. Instances also stop on their own after the inactivity timeout.',
      inputSchema: z.object({ instanceId: z.string().describe('ID of the instance to delete.') }),
      execute: async ({ instanceId }) => {
        await resources(instanceId).delete(instanceId);
        return { deleted: instanceId };
      },
    }),

    'list-apps': tool({
      description:
        'List apps available to be installed in iOS/Android simulators. Returns the asset names accepted by the apps field of create-ios-simulator and create-android-emulator, and by install-app.',
      inputSchema: z.object({ platform: z.enum(['ios', 'android']) }),
      execute: async ({ platform }) => {
        const assets = await limrun.assets.list({ kindFilter: 'App' });
        return { apps: assets.filter((a) => (a.platform ?? a.os) === platform).map((a) => a.name) };
      },
    }),

    'install-app': tool({
      description:
        "Install an app from the organization's Limrun asset storage on a running instance. iOS installs also launch the app.",
      inputSchema: z.object({
        instanceId: z.string().describe('Running instance to install on.'),
        app: z.string().describe('Asset name, as listed by list-apps.'),
      }),
      execute: async ({ instanceId, app }) => {
        const platform = platformOf(instanceId);
        const assets = await limrun.assets.list({
          nameFilter: app,
          kindFilter: 'App',
          includeDownloadUrl: true,
        });
        const asset = assets.find((a) => a.name === app && (a.platform ?? a.os) === platform);
        if (!asset?.signedDownloadUrl)
          throw new Error(`No ${platform} app asset named "${app}". Call list-apps.`);
        const url = asset.signedDownloadUrl;
        if (platform === 'android') {
          await withAndroid(instanceId, (c) => c.sendAsset(url));
          return { installed: app };
        }
        const result = await withIos(instanceId, (c) =>
          c.installApp(url, { ...(asset.md5 && { md5: asset.md5 }), launchMode: 'ForegroundIfRunning' }),
        );
        return { installed: app, ...result };
      },
    }),

    'ios-screenshot-and-element-tree': tool({
      description:
        'Get the current screenshot of the iOS simulator screen and the accessibility element tree. Call it before interacting so actions target what is currently on screen. The element tree is JSON describing UI elements, their types, labels and positions; it may not contain every visible element.',
      inputSchema: z.object({ instanceId: iosId }),
      execute: ({ instanceId }) =>
        withIos(instanceId, async (c) => {
          const { base64, width, height } = await c.screenshot();
          const elementTree = await c.elementTreeRaw();
          return { screenshot: { base64, mediaType: 'image/jpeg' }, width, height, elementTree };
        }),
      toModelOutput: ({ output }) => screenshotToModel(output),
    }),

    'ios-use': tool({
      description: `Perform a list of actions on the iOS simulator, in order. The batch stops at the first failed action.
For element actions, prefer a selector built from the element tree of ios-screenshot-and-element-tree. For tap, use exactly one targeting mode: selector, or x and y.
Keep action lists short; call this tool again for longer flows. Add a wait action before ios-screenshot-and-element-tree when the screen needs time to change.
To open a URL or deeplink, use ios-open-url. In Expo Go, press the capital R key twice to reload the app.
This tool returns only execution results; use ios-screenshot-and-element-tree for the latest visual state.`,
      inputSchema: z.object({
        actions: z.array(iosAction).describe('Actions to perform on the simulator, executed in order.'),
        instanceId: iosId,
      }),
      execute: ({ instanceId, actions }) =>
        withIos(instanceId, (c) => c.performActions(actions.map(toPerformAction))),
    }),

    'ios-open-url': tool({
      description:
        'Open a URL in the iOS simulator. Opens Safari for web URLs and the matching app for deeplinks. The URL must be publicly available; for a React Native app, open its public "exp://" URL to load it in Expo Go.',
      inputSchema: z.object({ url: z.string().describe('The URL to open'), instanceId: iosId }),
      execute: async ({ instanceId, url }) => {
        await withIos(instanceId, (c) => c.openUrl(url));
        return { opened: url };
      },
    }),

    'ios-app': tool({
      description:
        'List, launch, or terminate installed iOS simulator apps. This tool does not install apps; use install-app for that.',
      inputSchema: z.object({
        action: z
          .discriminatedUnion('kind', [
            z.object({ kind: z.literal('listApps') }),
            z.object({
              kind: z.literal('launchApp'),
              bundleId: z.string(),
              mode: z.enum(['ForegroundIfRunning', 'RelaunchIfRunning']).optional(),
            }),
            z.object({ kind: z.literal('terminateApp'), bundleId: z.string() }),
          ])
          .describe('The app operation to perform: list, launch, or terminate.'),
        instanceId: iosId,
      }),
      execute: ({ instanceId, action }) =>
        withIos(instanceId, async (c) => {
          switch (action.kind) {
            case 'listApps':
              return {
                apps: (await c.listApps()).map(({ bundleId, name, installType }) => ({
                  bundleId,
                  name,
                  installType,
                })),
              };
            case 'launchApp':
              await c.launchApp(action.bundleId, action.mode);
              return { launched: action.bundleId };
            case 'terminateApp':
              await c.terminateApp(action.bundleId);
              return { terminated: action.bundleId };
          }
        }),
    }),

    'ios-logs': tool({
      description: 'Fetch the last N combined stdout/stderr log lines for an installed iOS app bundle ID.',
      inputSchema: z.object({
        bundleId: z.string().describe('Bundle identifier of the app to fetch logs for.'),
        lines: z.number().default(200).describe('Number of log lines to return.'),
        instanceId: iosId,
      }),
      execute: ({ instanceId, bundleId, lines }) =>
        withIos(instanceId, async (c) => ({ logs: await c.appLogTail(bundleId, lines) })),
    }),

    'android-screenshot-and-element-tree': tool({
      description:
        'Returns the latest screenshot and Android UI hierarchy (UIAutomator XML) of the emulator.',
      inputSchema: z.object({ instanceId: androidId }),
      execute: ({ instanceId }) =>
        withAndroid(instanceId, async (c) => {
          const screenshot = await androidScreenshot(c);
          const { xml } = await c.getElementTree();
          return { screenshot, elementTree: xml };
        }),
      toModelOutput: ({ output }) => screenshotToModel(output),
    }),

    'android-use': tool({
      description: `Perform a list of actions on the Android emulator, in order. The list stops at the first failed action.
Selectors match attributes of the UI hierarchy XML from android-screenshot-and-element-tree: use resourceId for "resource-id", contentDesc for "content-desc", className for "class", packageName for "package". Combine fields to make a match specific.
For tap, use exactly one targeting mode: selector, or x and y. For scrollElement, give a selector for the container. Use findElement to check a selector before acting on it.
Add a wait action when the UI needs time to change, so the returned screenshot shows the final state. To open URLs and deeplinks, use android-open-url.
This tool returns the per-action results and a screenshot; call android-screenshot-and-element-tree for the element tree.`,
      inputSchema: z.object({
        actions: z.array(androidAction).describe('Actions to perform on the emulator, executed in order.'),
        instanceId: androidId,
      }),
      execute: ({ instanceId, actions }) =>
        withAndroid(instanceId, async (c) => {
          const results = [];
          for (const action of actions) results.push(await runAndroidAction(c, action));
          return { results, screenshot: await androidScreenshot(c) };
        }),
      toModelOutput: ({ output }) => screenshotToModel(output),
    }),

    'android-open-url': tool({
      description: 'Open a URL or deeplink on the Android instance.',
      inputSchema: z.object({
        url: z.string().describe('The URL or deeplink to open'),
        instanceId: androidId,
      }),
      execute: ({ instanceId, url }) => withAndroid(instanceId, (c) => c.openUrl(url)),
    }),
  };
}
