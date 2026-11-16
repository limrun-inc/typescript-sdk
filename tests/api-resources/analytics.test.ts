// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import Limrun from '@limrun/api';

const client = new Limrun({
  apiKey: 'My API Key',
  baseURL: process.env['TEST_API_BASE_URL'] ?? 'http://127.0.0.1:4010',
});

describe('resource analytics', () => {
  // Mock server tests are disabled
  test.skip('get: only required params', async () => {
    const responsePromise = client.analytics.get({
      from: '2019-12-27T18:11:19.117Z',
      to: '2019-12-27T18:11:19.117Z',
    });
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Mock server tests are disabled
  test.skip('get: required and optional params', async () => {
    const response = await client.analytics.get({
      from: '2019-12-27T18:11:19.117Z',
      to: '2019-12-27T18:11:19.117Z',
      bucket: 'hour',
      labels: 'labels',
      region: 'region',
      timezone: 'timezone',
    });
  });

  // Mock server tests are disabled
  test.skip('getInstances: only required params', async () => {
    const responsePromise = client.analytics.getInstances({
      from: '2019-12-27T18:11:19.117Z',
      to: '2019-12-27T18:11:19.117Z',
    });
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  test('getInstances: exposes exact credits and lifetime', async () => {
    const body = {
      asOf: '2026-11-15T15:41:18.15484819Z',
      timezone: 'UTC',
      series: [
        {
          timestamp: '2026-11-15T15:40:00Z',
          instances: [
            {
              instanceTid: 'android_usw1_01krxvphn8e3rbeq0zewgw209a',
              platform: 'android',
              region: 'us-west1',
              runtimeMinutes: 1,
              billedMinutes: 1,
              billedCredits: '1',
              wallclockMinutes: 1,
              cost: 0,
              billedBreakdown: {
                creditsBilled: '1',
                creditsBilledMinutes: 1,
                onDemandBilledCredits: '0',
                onDemandBilledMinutes: 0,
              },
            },
          ],
        },
      ],
    };
    const fetchClient = new Limrun({
      apiKey: 'My API Key',
      baseURL: 'http://localhost',
      fetch: async () =>
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
    });

    const response = await fetchClient.analytics.getInstances({
      stoppedAt: { gte: '2026-11-15T15:40:00Z' },
      timezone: 'UTC',
    });
    const instance = response.series[0]!.instances[0]!;
    const billedCredits: string | undefined = instance.billedCredits;
    const wallclockMinutes: number | undefined = instance.wallclockMinutes;
    const creditsBilled: string | undefined = instance.billedBreakdown?.creditsBilled;

    expect(billedCredits).toBe('1');
    expect(wallclockMinutes).toBe(1);
    expect(creditsBilled).toBe('1');
    expect(instance.billedBreakdown?.onDemandBilledCredits).toBe('0');
  });

  // Mock server tests are disabled
  test.skip('getInstances: required and optional params', async () => {
    const response = await client.analytics.getInstances({
      from: '2019-12-27T18:11:19.117Z',
      to: '2019-12-27T18:11:19.117Z',
      labels: 'labels',
      region: 'region',
      timezone: 'timezone',
    });
  });
});
