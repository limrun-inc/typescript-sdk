import { AuthenticationError } from '@limrun/api';

import { getSecret, putSecret, whoAmI } from './backend';

const creds = { apiEndpoint: 'https://api.example.test', apiKey: 'key' };

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('backend client', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('whoAmI', () => {
    it('resolves the organization for org tokens', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { type: 'organization', organization: { id: 'org_1' } }));
      await expect(whoAmI(creds)).resolves.toEqual({ organizationId: 'org_1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${creds.apiEndpoint}/v1/whoami`);
      expect(init.headers.Authorization).toBe('Bearer key');
    });

    it('falls back to the default organization NESTED IN user for user tokens', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { type: 'user', user: { defaultOrganization: { id: 'org_2' } } }),
      );
      await expect(whoAmI(creds)).resolves.toEqual({ organizationId: 'org_2' });
    });

    it('throws the SDK AuthenticationError on 401 so withAuth can re-login', async () => {
      fetchMock.mockResolvedValue(mockResponse(401, {}));
      await expect(whoAmI(creds)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('fails when no organization is reported', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { type: 'user', user: {} }));
      await expect(whoAmI(creds)).rejects.toThrow(/did not report an organization/);
    });
  });

  describe('getSecret', () => {
    it('returns undefined on 404', async () => {
      fetchMock.mockResolvedValue(mockResponse(404, { message: 'not found' }));
      await expect(getSecret(creds, 'org_1', 'androidSigningKey', 'com.x')).resolves.toBeUndefined();
    });

    it('URL-encodes path segments and returns the data', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'upload' } }));
      await expect(getSecret(creds, 'org/1', 'androidSigningKey', 'com/x')).resolves.toEqual({
        keyAlias: 'upload',
      });
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(
        `${creds.apiEndpoint}/v1/organizations/org%2F1/secrets/androidSigningKey/com%2Fx`,
      );
    });

    it('surfaces the API error message', async () => {
      fetchMock.mockResolvedValue(mockResponse(500, { message: 'db down' }));
      await expect(getSecret(creds, 'org_1', 'androidSigningKey', 'com.x')).rejects.toThrow(/db down/);
    });
  });

  describe('putSecret', () => {
    it("reads `created` from the response body (today's 200-only server)", async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'upload' }, created: true }));
      await expect(
        putSecret(creds, 'org_1', 'androidSigningKey', 'com.x', { keyAlias: 'upload' }),
      ).resolves.toEqual({ data: { keyAlias: 'upload' }, created: true });
    });

    it('falls back to HTTP 201 when the body has no created field (status-split server)', async () => {
      fetchMock.mockResolvedValue(mockResponse(201, { data: { keyAlias: 'upload' } }));
      await expect(
        putSecret(creds, 'org_1', 'androidSigningKey', 'com.x', { keyAlias: 'upload' }),
      ).resolves.toEqual({ data: { keyAlias: 'upload' }, created: true });
    });

    it('returns the WINNER data on a get-or-create hit, not the submitted data', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'winner' }, created: false }));
      const result = await putSecret(creds, 'org_1', 'androidSigningKey', 'com.x', { keyAlias: 'loser' });
      expect(result).toEqual({ data: { keyAlias: 'winner' }, created: false });
    });

    it('rejects validation failures with the API message', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, { message: 'keystoreBase64 is required' }));
      await expect(putSecret(creds, 'org_1', 'androidSigningKey', 'com.x', {})).rejects.toThrow(
        /keystoreBase64 is required/,
      );
    });
  });
});
