import type { AppleRelayResponse, AppleRelayWebSocketClient } from '../relay';

export type PortalEnvelope = { resultCode?: number; resultString?: string; userString?: string };

export type PortalRequest = {
  method?: 'GET' | 'POST';
  path: string;
  payload?: unknown;
};

export async function portalRequest<T extends PortalEnvelope = PortalEnvelope>(
  relay: AppleRelayWebSocketClient,
  request: PortalRequest,
  label: string,
): Promise<T> {
  const response = await relay.request<T>('provisioning', request);
  const body = response.body;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `${label} failed: HTTP ${response.status} ${
        body?.userString ?? body?.resultString ?? response.statusText
      }`,
    );
  }
  if (!body) {
    throw new Error(`${label} returned an empty response.`);
  }
  if (body.resultCode !== undefined && body.resultCode !== 0) {
    throw new Error(`${label} failed: ${body.userString ?? body.resultString ?? body.resultCode}`);
  }
  return body;
}

/** A download endpoint returns raw bytes, not a portal result envelope. */
export async function portalDownload(
  relay: AppleRelayWebSocketClient,
  request: PortalRequest,
): Promise<AppleRelayResponse> {
  const response = await relay.request<PortalEnvelope>('provisioning', request);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Apple download failed: HTTP ${response.status} ${response.statusText}`);
  }
  if (response.body?.resultCode !== undefined && response.body.resultCode !== 0) {
    throw new Error(
      `Apple download failed: ${
        response.body.userString ?? response.body.resultString ?? response.body.resultCode
      }`,
    );
  }
  return response;
}

export const PORTAL_PAGE_SIZE = 200;

export function paged(path: string, teamId: string, payload: Record<string, unknown> = {}): PortalRequest {
  return {
    method: 'POST',
    path,
    payload: {
      pageNumber: 1,
      pageSize: PORTAL_PAGE_SIZE,
      sort: 'name=asc',
      ...(teamId ? { teamId } : {}),
      ...payload,
    },
  };
}
