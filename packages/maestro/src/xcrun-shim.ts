import { createXcrunShim, startXcrunShimServer } from '@limrun/api/ios-shim';

import type { LimrunMaestroClient, ShimServer } from './types';

export { createXcrunShim };

export async function startShimServer({
  client,
  udid,
}: {
  client: LimrunMaestroClient;
  udid: string;
}): Promise<ShimServer> {
  return await startXcrunShimServer({ client, udid });
}
