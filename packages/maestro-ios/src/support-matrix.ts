export type RouteSupportStatus = 'implemented' | 'best-effort' | 'unsupported';

export type RouteSupport = {
  route: string;
  maestroSurface: string;
  status: RouteSupportStatus;
  notes: string;
};

export const routeSupportMatrix = [
  { route: 'open', maestroSurface: 'Driver lifecycle', status: 'implemented', notes: 'Marks the bridge driver open.' },
  { route: 'close', maestroSurface: 'Driver lifecycle', status: 'implemented', notes: 'Marks the bridge driver closed.' },
  { route: 'deviceInfo', maestroSurface: 'Device metadata', status: 'implemented', notes: 'Uses Limrun iOS screen dimensions.' },
  { route: 'launchApp', maestroSurface: 'launchApp', status: 'best-effort', notes: 'Launches an already-installed app by bundle id; non-empty launchArguments fail clearly.' },
  { route: 'stopApp', maestroSurface: 'stopApp', status: 'implemented', notes: 'Terminates an app by bundle id.' },
  { route: 'clearAppState', maestroSurface: 'clearState', status: 'best-effort', notes: 'Uses Limrun softReset data strategy, which relaunches the app after reset.' },
  { route: 'tap', maestroSurface: 'tapOn / point taps', status: 'implemented', notes: 'Maestro resolves selectors, then the bridge taps coordinates.' },
  { route: 'longPress', maestroSurface: 'longPressOn', status: 'implemented', notes: 'Uses low-level touch down/wait/up actions.' },
  { route: 'pressKey', maestroSurface: 'pressKey / back', status: 'implemented', notes: 'Maps common Maestro key names to Limrun iOS key names.' },
  { route: 'inputText', maestroSurface: 'inputText and random input commands', status: 'implemented', notes: 'Types text through the Limrun iOS client.' },
  { route: 'openLink', maestroSurface: 'openLink', status: 'implemented', notes: 'Opens URLs through the simulator URL handler.' },
  { route: 'hideKeyboard', maestroSurface: 'hideKeyboard', status: 'best-effort', notes: 'Sends Escape to dismiss visible keyboard-like UI.' },
  { route: 'contentDescriptor', maestroSurface: 'assertions and selectors', status: 'implemented', notes: 'Maps the Limrun accessibility tree into Maestro TreeNode shape.' },
  { route: 'scroll', maestroSurface: 'scroll / scrollUntilVisible', status: 'implemented', notes: 'Uses Limrun iOS scroll primitives.' },
  { route: 'swipe', maestroSurface: 'swipe by points', status: 'implemented', notes: 'Uses low-level touch actions.' },
  { route: 'swipeDirection', maestroSurface: 'swipe direction', status: 'best-effort', notes: 'Maps Maestro directions to Limrun scroll direction.' },
  { route: 'swipeElement', maestroSurface: 'swipe on element', status: 'best-effort', notes: 'Uses the element point as a scroll origin.' },
  { route: 'isKeyboardVisible', maestroSurface: 'Keyboard checks', status: 'best-effort', notes: 'Reports false because Limrun iOS does not currently expose keyboard visibility.' },
  { route: 'takeScreenshot', maestroSurface: 'takeScreenshot / assertScreenshot', status: 'implemented', notes: 'Returns simulator screenshots to Maestro.' },
  { route: 'startScreenRecording', maestroSurface: 'startRecording', status: 'implemented', notes: 'Starts Limrun iOS recording.' },
  { route: 'stopScreenRecording', maestroSurface: 'stopRecording', status: 'implemented', notes: 'Stops recording, downloads video locally, and streams it back to Maestro.' },
  { route: 'waitUntilScreenIsStatic', maestroSurface: 'waitForAnimationToEnd', status: 'best-effort', notes: 'Waits briefly and reports static; pixel stability is not exposed yet.' },
  { route: 'waitForAppToSettle', maestroSurface: 'Launch settle wait', status: 'best-effort', notes: 'Waits briefly and lets Maestro continue hierarchy polling.' },
  { route: 'setOrientation', maestroSurface: 'setOrientation', status: 'implemented', notes: 'Maps portrait/landscape orientations to Limrun iOS.' },
  { route: 'eraseText', maestroSurface: 'eraseText', status: 'implemented', notes: 'Sends repeated backspace key presses.' },
  { route: 'clearKeychain', maestroSurface: 'clearKeychain', status: 'unsupported', notes: 'No current Limrun iOS primitive for keychain clearing.' },
  { route: 'setPermissions', maestroSurface: 'setPermissions', status: 'best-effort', notes: 'Empty permission maps are accepted because Maestro sends them during launch; non-empty permission changes fail clearly.' },
  { route: 'addMedia', maestroSurface: 'addMedia', status: 'unsupported', notes: 'No current Limrun iOS primitive for adding simulator media.' },
  { route: 'setLocation', maestroSurface: 'setLocation', status: 'unsupported', notes: 'Deferred until Limrun iOS exposes location simulation.' },
  { route: 'setProxy', maestroSurface: 'setProxy', status: 'unsupported', notes: 'Deferred until proxy primitives are available.' },
  { route: 'resetProxy', maestroSurface: 'resetProxy', status: 'unsupported', notes: 'Deferred until proxy primitives are available.' },
  { route: 'isAirplaneModeEnabled', maestroSurface: 'Airplane mode queries', status: 'unsupported', notes: 'Deferred because airplane mode is not exposed on Limrun iOS.' },
  { route: 'setAirplaneMode', maestroSurface: 'setAirplaneMode', status: 'unsupported', notes: 'Deferred because airplane mode is not exposed on Limrun iOS.' },
] as const satisfies readonly RouteSupport[];

export type BridgeRoute = (typeof routeSupportMatrix)[number]['route'];

export const routeSupportByName: Record<string, RouteSupport> = Object.fromEntries(
  routeSupportMatrix.map((item) => [item.route, item]),
);

export function requireSupportedRoute(route: string): RouteSupport {
  const support = routeSupportByName[route];
  if (!support) {
    throw new UnsupportedRouteError(route, `Unsupported bridge route: ${route}`);
  }

  if (support.status === 'unsupported') {
    throw new UnsupportedRouteError(route, `Maestro command is not supported on Limrun iOS yet: ${support.maestroSurface}. ${support.notes}`);
  }

  return support;
}

export class UnsupportedRouteError extends Error {
  constructor(readonly route: string, message: string) {
    super(message);
    this.name = 'UnsupportedRouteError';
  }
}
