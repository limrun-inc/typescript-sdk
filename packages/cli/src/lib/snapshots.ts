import type Limrun from '@limrun/api';

type Snapshot = {
  key: string;
  archiveSizeBytes?: number;
  publishedAt?: string;
};

function encodePathParameter(value: string, name: string): string {
  // URL normalizes dot segments even when percent-encoded; an empty key targets the collection.
  if (value === '' || value === '.' || value === '..') {
    throw new Error(`${name} must not be empty, "." or ".."`);
  }
  return encodeURIComponent(value);
}

// Backend commands use the stable SDK transport so CLI releases do not require
// a newly published SDK resource class just to call an organization endpoint.
export function snapshotResource(client: Limrun, kind: 'xcode' | 'ios', organizationId: string) {
  const base = `/v1/organizations/${encodePathParameter(
    organizationId,
    'Organization ID',
  )}/${kind}_snapshots`;
  return {
    list: (query: { prefix: string | undefined; limit: number; offset: number }) =>
      client.get<{ snapshots: Snapshot[]; nextOffset?: number }>(base, { query }),
    get: (key: string) =>
      client.get<Snapshot & Record<string, unknown>>(`${base}/${encodePathParameter(key, 'Snapshot key')}`),
    delete: (key: string) =>
      client.delete<void>(`${base}/${encodePathParameter(key, 'Snapshot key')}`, {
        headers: { Accept: '*/*' },
      }),
  };
}
