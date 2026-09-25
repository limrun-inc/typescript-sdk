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

describe('analytics time filter serialization', () => {
  const from = '2026-09-25T00:00:00+03:00';
  const to = '2026-09-26T00:00:00+03:00';

  test.each(['get', 'getInstances'] as const)('%s sends independent time bounds', async (method) => {
    let requestedURL = '';
    const api = new Limrun({
      apiKey: 'test',
      fetch: async (input) => {
        requestedURL = String(input);
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });
    await api.analytics[method]({
      startedAt: { after: from, before: to },
      stoppedAt: { after: from, before: to },
      labels: 'customer=acme',
    });
    const query = new URL(requestedURL).searchParams;
    expect(Object.fromEntries(query)).toEqual({
      'startedAt[after]': from,
      'startedAt[before]': to,
      'stoppedAt[after]': from,
      'stoppedAt[before]': to,
      labels: 'customer=acme',
    });
  });

  test.each(['get', 'getInstances'] as const)('%s keeps legacy ranges unchanged', async (method) => {
    let requestedURL = '';
    const api = new Limrun({
      apiKey: 'test',
      fetch: async (input) => {
        requestedURL = String(input);
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });
    await api.analytics[method]({ from, to });
    expect(Object.fromEntries(new URL(requestedURL).searchParams)).toEqual({ from, to });
  });

  test('getInstances accepts a stoppedAt-only query', async () => {
    let requestedURL = '';
    const api = new Limrun({
      apiKey: 'test',
      fetch: async (input) => {
        requestedURL = String(input);
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      },
    });
    await api.analytics.getInstances({ stoppedAt: { after: from, before: to } });
    expect(Object.fromEntries(new URL(requestedURL).searchParams)).toEqual({
      'stoppedAt[after]': from,
      'stoppedAt[before]': to,
    });
  });
});
