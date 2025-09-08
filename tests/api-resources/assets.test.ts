// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import Limrun from '@limrun/api';

const client = new Limrun({
  apiKey: 'My API Key',
  baseURL: process.env['TEST_API_BASE_URL'] ?? 'http://127.0.0.1:4010',
});

describe('resource assets', () => {
  // Prism tests are disabled
  test.skip('list', async () => {
    const responsePromise = client.assets.list();
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Prism tests are disabled
  test.skip('list: request options and params are passed correctly', async () => {
    // ensure the request options are being passed correctly by passing an invalid HTTP method in order to cause an error
    await expect(
      client.assets.list(
        {
          includeDownloadUrl: true,
          includeUploadUrl: true,
          md5Filter: 'md5Filter',
          nameFilter: 'nameFilter',
        },
        { path: '/_stainless_unknown_path' },
      ),
    ).rejects.toThrow(Limrun.NotFoundError);
  });

  // Prism tests are disabled
  test.skip('get', async () => {
    const responsePromise = client.assets.get('assetId');
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Prism tests are disabled
  test.skip('get: request options and params are passed correctly', async () => {
    // ensure the request options are being passed correctly by passing an invalid HTTP method in order to cause an error
    await expect(
      client.assets.get(
        'assetId',
        { includeDownloadUrl: true, includeUploadUrl: true },
        { path: '/_stainless_unknown_path' },
      ),
    ).rejects.toThrow(Limrun.NotFoundError);
  });

  // Prism tests are disabled
  test.skip('getOrCreate: only required params', async () => {
    const responsePromise = client.assets.getOrCreate({ name: 'name' });
    const rawResponse = await responsePromise.asResponse();
    expect(rawResponse).toBeInstanceOf(Response);
    const response = await responsePromise;
    expect(response).not.toBeInstanceOf(Response);
    const dataAndResponse = await responsePromise.withResponse();
    expect(dataAndResponse.data).toBe(response);
    expect(dataAndResponse.response).toBe(rawResponse);
  });

  // Prism tests are disabled
  test.skip('getOrCreate: required and optional params', async () => {
    const response = await client.assets.getOrCreate({ name: 'name' });
  });
});
