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
