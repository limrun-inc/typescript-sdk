import { PLAY_CONSOLE_SCOPE, PLAY_DEVELOPER_APP_SCOPE } from './google';

const CONSOLE_API = 'https://playconsoleapps-pa.clients6.google.com';

export type PlayConsoleApp = { developerId: string; appId: string };
export type PlayConsoleAuth = {
  /** Requires a Google-approved Console scope; androidpublisher alone is insufficient. */
  accessToken: string;
  signal?: AbortSignal;
};
export type CreatePlayConsoleAppInput = PlayConsoleAuth & {
  developerId: string;
  packageName: string;
  title: string;
  defaultLanguage: string;
  appType: 'app' | 'game';
  paid: boolean;
  /** Obtain these declarations from the user; do not accept them automatically. */
  appMeetsGuidelines: boolean;
  usExportCompliant: boolean;
};

/** Reports a Console failure without including credentials or upstream response bodies. */
export class PlayConsoleError extends Error {
  readonly status: number | undefined;
  /** A mutation may have completed. Check the account before repeating creation. */
  readonly outcomeUnknown: boolean;
  constructor(message: string, status?: number, outcomeUnknown = false) {
    super(message);
    this.name = 'PlayConsoleError';
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

/**
 * Creates a draft app using the experimental Console API. Requires Google-approved scopes.
 * Does not enroll signing, upload a binary, publish a release, or retry requests.
 */
export async function createPlayConsoleApp(input: CreatePlayConsoleAppInput): Promise<PlayConsoleApp> {
  const developerId = consoleId(input.developerId, 'developer ID');
  const packageName = input.packageName.trim();
  const title = input.title.trim();
  const language = input.defaultLanguage.trim();
  if (!packageName || !title || !language)
    throw new Error('Package name, title, and default language are required.');
  if (input.appMeetsGuidelines !== true || input.usExportCompliant !== true) {
    throw new Error(
      'Confirm the Developer Program Policies and US export declarations before creating an app.',
    );
  }
  if (!['app', 'game'].includes(input.appType) || typeof input.paid !== 'boolean') {
    throw new Error('Select an app type and whether the app is paid.');
  }
  const response = await consoleRequest(input, `/v1/developers/${developerId}:createAppV2`, {
    '1': { '1': developerId },
    '2': title,
    '3': language,
    '4': input.appType === 'game' ? 2 : 1,
    '5': input.paid,
    '6': true,
    '7': true,
    '9': { '1': true },
    '11': packageName,
  });
  try {
    const body = await response.json();
    const app = body?.['1'];
    if (app?.['1']?.['1'] !== developerId || !isConsoleId(app?.['2']?.['1']))
      throw new Error('Invalid app reference');
    return { developerId, appId: app['2']['1'] };
  } catch {
    throw new PlayConsoleError(
      'Play Console returned an invalid app reference. Check the account before retrying creation.',
      response.status,
      true,
    );
  }
}

/** Asks Google to generate and manage the new app's distribution signing key. */
export async function enrollPlayAppSigning(input: PlayConsoleAuth & PlayConsoleApp): Promise<void> {
  const developerId = consoleId(input.developerId, 'developer ID');
  const appId = consoleId(input.appId, 'app ID');
  await consoleRequest(input, `/v1/developers/${developerId}/apps/${appId}/appSigning:autoEnrollNewApp`, {
    '1': { '1': { '1': developerId }, '2': { '1': appId } },
  });
}

function isConsoleId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
function consoleId(value: string, label: string): string {
  const id = value.trim();
  if (!isConsoleId(id)) throw new Error(`A numeric Play Console ${label} is required.`);
  return id;
}
async function consoleRequest(auth: PlayConsoleAuth, path: string, body: unknown): Promise<Response> {
  if (!auth.accessToken.trim()) throw new Error('A Google access token is required.');
  let response: Response;
  try {
    response = await fetch(`${CONSOLE_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json+protobuf' },
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: auth.signal,
    });
  } catch {
    throw new PlayConsoleError(
      'Play Console could not be reached or the request was interrupted. The operation may have completed; check the account before retrying creation.',
      undefined,
      true,
    );
  }
  if (!response.ok) {
    const message =
      response.status === 401 ? 'The Google session expired or is invalid. Sign in again.'
      : response.status === 403 ?
        `Play Console denied access. This operation requires Google approval for ${PLAY_CONSOLE_SCOPE} or ${PLAY_DEVELOPER_APP_SCOPE}, plus permission in the developer account. androidpublisher alone is insufficient.`
      : `Play Console request failed with HTTP ${response.status}.`;
    throw new PlayConsoleError(message, response.status, response.status >= 500 || response.status === 408);
  }
  return response;
}
