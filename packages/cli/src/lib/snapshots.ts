import type Limrun from '@limrun/api';

type Snapshot = {
  key: string;
  archiveSizeBytes?: number;
  publishedAt?: string;
};

// Backend commands use the stable SDK transport so CLI releases do not require
// a newly published SDK resource class just to call an organization endpoint.
export function snapshotResource(client: Limrun, kind: 'xcode' | 'ios', organizationId: string) {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/${kind}_snapshots`;
  return {
    list: (query: { prefix: string | undefined; limit: number; offset: number }) =>
      client.get<{ snapshots: Snapshot[]; nextOffset?: number }>(base, { query }),
    get: (key: string) =>
      client.get<Snapshot & Record<string, unknown>>(`${base}/${encodeURIComponent(key)}`),
    delete: (key: string) =>
      client.delete<void>(`${base}/${encodeURIComponent(key)}`, { headers: { Accept: '*/*' } }),
  };
}
