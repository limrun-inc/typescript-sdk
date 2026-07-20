import { getSecret, putSecret, whoAmI } from './backend';

const apiEndpoint = 'https://api.example.test';

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
      fetchMock.mockResolvedValue(mockResponse(200, { organization: { id: 'org_1' } }));
      await expect(whoAmI(apiEndpoint, 'key')).resolves.toEqual({ organizationId: 'org_1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${apiEndpoint}/v1/whoami`);
      expect(init.headers.Authorization).toBe('Bearer key');
    });

    it('falls back to the default organization for user tokens', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { user: {}, defaultOrganization: { id: 'org_2' } }));
      await expect(whoAmI(apiEndpoint, 'key')).resolves.toEqual({ organizationId: 'org_2' });
    });

    it('reports an unusable key as a login problem', async () => {
      fetchMock.mockResolvedValue(mockResponse(401, {}));
      await expect(whoAmI(apiEndpoint, 'key')).rejects.toThrow(/lim login/);
    });

    it('fails when no organization is reported', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { user: {} }));
      await expect(whoAmI(apiEndpoint, 'key')).rejects.toThrow(/did not report an organization/);
    });
  });

  describe('getSecret', () => {
    it('returns undefined on 404', async () => {
      fetchMock.mockResolvedValue(mockResponse(404, { message: 'not found' }));
      await expect(
        getSecret(apiEndpoint, 'key', 'org_1', 'androidSigningKey', 'com.x'),
      ).resolves.toBeUndefined();
    });

    it('URL-encodes path segments and returns the data', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'upload' } }));
      await expect(getSecret(apiEndpoint, 'key', 'org/1', 'androidSigningKey', 'com/x')).resolves.toEqual({
        keyAlias: 'upload',
      });
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${apiEndpoint}/v1/organizations/org%2F1/secrets/androidSigningKey/com%2Fx`);
    });

    it('surfaces the API error message', async () => {
      fetchMock.mockResolvedValue(mockResponse(500, { message: 'db down' }));
      await expect(getSecret(apiEndpoint, 'key', 'org_1', 'androidSigningKey', 'com.x')).rejects.toThrow(
        /db down/,
      );
    });
  });

  describe('putSecret', () => {
    it('reports created on 201', async () => {
      fetchMock.mockResolvedValue(mockResponse(201, { data: { keyAlias: 'upload' } }));
      const result = await putSecret(apiEndpoint, 'key', 'org_1', 'androidSigningKey', 'com.x', {
        keyAlias: 'upload',
      });
      expect(result).toEqual({ data: { keyAlias: 'upload' }, created: true });
    });

    it('returns the WINNER data on a get-or-create hit, not the submitted data', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'winner' } }));
      const result = await putSecret(apiEndpoint, 'key', 'org_1', 'androidSigningKey', 'com.x', {
        keyAlias: 'loser',
      });
      expect(result).toEqual({ data: { keyAlias: 'winner' }, created: false });
    });

    it('rejects validation failures with the API message', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, { message: 'keystoreBase64 is required' }));
      await expect(putSecret(apiEndpoint, 'key', 'org_1', 'androidSigningKey', 'com.x', {})).rejects.toThrow(
        /keystoreBase64 is required/,
      );
    });
  });
});
