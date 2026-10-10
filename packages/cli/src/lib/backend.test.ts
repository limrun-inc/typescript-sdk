import Limrun, { AuthenticationError } from '@limrun/api';

import {
  createQuickTunnel,
  deleteTunnel,
  findTunnel,
  getSecret,
  putSecret,
  rotateTunnelToken,
  tunnelOrganization,
  updateTunnelSelectors,
  tunnelTokenClaims,
  whoAmI,
} from './backend';

const apiEndpoint = 'https://api.example.test';

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('backend client', () => {
  let fetchMock: jest.SpyInstance;
  let client: Limrun;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    client = new Limrun({ apiKey: 'key', baseURL: apiEndpoint, maxRetries: 0 });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function requestOf(call: unknown[]): { url: string; auth: string | null } {
    const [input, init] = call as [string | URL, RequestInit | undefined];
    return {
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
    };
  }

  describe('tunnels', () => {
    // A signed token's header and signature do not matter here; only the
    // payload's claims are read.
    function signedToken(claims: object | null): string {
      return `lim_st_eyJhbGciOiJFZERTQSJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;
    }

    it('reads the organization and tunnel a tunnel token names', () => {
      expect(
        tunnelTokenClaims(
          signedToken({ sub: 'org_1', scopes: ['tunnel:tunnel_01h455vb4pex5vsknk084sn02q:connect'] }),
        ),
      ).toEqual({ organizationId: 'org_1', tunnelId: 'tunnel_01h455vb4pex5vsknk084sn02q' });
    });

    it.each([
      ['a payload that is null', null],
      ['an instance token', { sub: 'org_1', scopes: ['ios:ios_euna_x:all'] }],
      ['a token for every tunnel', { sub: 'org_1', scopes: ['tunnel:*:connect'] }],
      [
        'a token with more than its tunnel',
        { sub: 'org_1', scopes: ['tunnel:tunnel_01h455vb4pex5vsknk084sn02q:connect', 'ios:*:read'] },
      ],
    ])('reads no tunnel from %s', (_, claims: object | null) => {
      expect(tunnelTokenClaims(signedToken(claims))).toBeUndefined();
    });

    it("asks whoami for the organization of an admin's key", async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { organization: { id: 'org_1' } }));
      await expect(tunnelOrganization(client)).resolves.toBe('org_1');
    });

    it('refuses a signed token as the API key, without a call', async () => {
      const tokenClient = new Limrun({
        apiKey: signedToken({ sub: 'org_1', scopes: ['tunnel:tunnel_01h455vb4pex5vsknk084sn02q:connect'] }),
        baseURL: apiEndpoint,
        maxRetries: 0,
      });
      await expect(tunnelOrganization(tokenClient)).rejects.toThrow('--token or LIM_TUNNEL_TOKEN');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('finds a tunnel by name and creates a quick one', async () => {
      fetchMock.mockResolvedValueOnce(
        mockResponse(200, { tunnels: [{ id: 'tunnel_1', name: 'staging', ephemeral: false }] }),
      );
      await expect(findTunnel(client, 'org_1', 'staging')).resolves.toEqual({
        id: 'tunnel_1',
        name: 'staging',
        ephemeral: false,
      });
      expect(requestOf(fetchMock.mock.calls[0]).url).toBe(`${apiEndpoint}/v1/organizations/org_1/tunnels`);

      fetchMock.mockResolvedValueOnce(
        mockResponse(201, {
          tunnel: { id: 'tunnel_2', name: 'scratch', ephemeral: true },
          token: { token: 'lim_st_quick', expiresAt: '2026-11-09T00:00:00Z' },
        }),
      );
      await expect(createQuickTunnel(client, 'org_1', 'scratch', ['localhost:3000'])).resolves.toEqual({
        tunnel: { id: 'tunnel_2', name: 'scratch', ephemeral: true },
        token: 'lim_st_quick',
      });
      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        name: 'scratch',
        selectors: ['localhost:3000'],
        ephemeral: true,
        token: { expirationMonths: 1 },
      });

      // Without its token the tunnel could not run, so the create fails and
      // the tunnel goes at once.
      fetchMock.mockResolvedValueOnce(
        mockResponse(201, { tunnel: { id: 'tunnel_3', name: 'other', ephemeral: true } }),
      );
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(createQuickTunnel(client, 'org_1', 'other', ['localhost:3000'])).rejects.toThrow(
        'returned no token',
      );
      const [deleteURL, deleteInit] = fetchMock.mock.calls[3] as [string, RequestInit];
      expect(deleteURL).toBe(`${apiEndpoint}/v1/organizations/org_1/tunnels/tunnel_3`);
      expect(deleteInit.method).toBe('DELETE');
    });

    it('replaces selectors and rotates the token of a tunnel by its ID', async () => {
      const tunnel = {
        id: 'tunnel_1',
        name: 'staging',
        ephemeral: false,
        online: true,
        selectors: [],
        instances: [],
      };
      fetchMock.mockResolvedValueOnce(mockResponse(200, { ...tunnel, selectors: ['localhost:4000'] }));
      await updateTunnelSelectors(client, 'org_1', tunnel, ['localhost:4000']);
      const [updateURL, updateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(updateURL).toBe(`${apiEndpoint}/v1/organizations/org_1/tunnels/tunnel_1`);
      expect(updateInit.method).toBe('PATCH');
      expect(JSON.parse(String(updateInit.body))).toEqual({ selectors: ['localhost:4000'] });

      fetchMock.mockResolvedValueOnce(
        mockResponse(201, { token: 'lim_st_new', expiresAt: '2027-10-10T00:00:00Z' }),
      );
      await expect(rotateTunnelToken(client, 'org_1', tunnel, 3)).resolves.toEqual({
        token: 'lim_st_new',
        expiresAt: '2027-10-10T00:00:00Z',
      });
      const [rotateURL, rotateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(rotateURL).toBe(`${apiEndpoint}/v1/organizations/org_1/tunnels/tunnel_1/token`);
      expect(rotateInit.method).toBe('POST');
      expect(JSON.parse(String(rotateInit.body))).toEqual({ expirationMonths: 3 });
    });

    it('deletes a quick tunnel by ID, and a tunnel the hub already removed is fine', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await deleteTunnel(client, 'org_1', 'tunnel_2');
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${apiEndpoint}/v1/organizations/org_1/tunnels/tunnel_2`);
      expect(init.method).toBe('DELETE');

      fetchMock.mockResolvedValueOnce(mockResponse(404, { message: 'tunnel not found' }));
      await expect(deleteTunnel(client, 'org_1', 'tunnel_2')).resolves.toBeUndefined();
    });
  });

  describe('whoAmI', () => {
    it('resolves the organization for org tokens with the bearer key', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { type: 'organization', organization: { id: 'org_1' } }));
      await expect(whoAmI(client)).resolves.toBe('org_1');
      const { url, auth } = requestOf(fetchMock.mock.calls[0]);
      expect(url).toBe(`${apiEndpoint}/v1/whoami`);
      expect(auth).toBe('Bearer key');
    });

    it('falls back to the default organization NESTED IN user for user tokens', async () => {
      fetchMock.mockResolvedValue(
        mockResponse(200, { type: 'user', user: { defaultOrganization: { id: 'org_2' } } }),
      );
      await expect(whoAmI(client)).resolves.toBe('org_2');
    });

    it('throws the SDK AuthenticationError on 401 so withAuth can re-login', async () => {
      fetchMock.mockResolvedValue(mockResponse(401, {}));
      await expect(whoAmI(client)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('fails when no organization is reported', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { type: 'user', user: {} }));
      await expect(whoAmI(client)).rejects.toThrow(/did not report an organization/);
    });
  });

  describe('getSecret', () => {
    it('returns undefined on 404', async () => {
      fetchMock.mockResolvedValue(mockResponse(404, { message: 'not found' }));
      await expect(getSecret(client, 'org_1', 'androidSigningKey', 'com.x')).resolves.toBeUndefined();
    });

    it('URL-encodes path segments and returns the data', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'upload' } }));
      await expect(getSecret(client, 'org/1', 'androidSigningKey', 'com/x')).resolves.toEqual({
        keyAlias: 'upload',
      });
      const { url } = requestOf(fetchMock.mock.calls[0]);
      expect(url).toBe(`${apiEndpoint}/v1/organizations/org%2F1/secrets/androidSigningKey/com%2Fx`);
    });

    it('surfaces the API error message', async () => {
      fetchMock.mockResolvedValue(mockResponse(500, { message: 'db down' }));
      await expect(getSecret(client, 'org_1', 'androidSigningKey', 'com.x')).rejects.toThrow(/db down/);
    });
  });

  describe('putSecret', () => {
    it("reads `created` from the response body (today's 200-only server)", async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'upload' }, created: true }));
      await expect(
        putSecret(client, 'org_1', 'androidSigningKey', 'com.x', { keyAlias: 'upload' }),
      ).resolves.toEqual({
        data: { keyAlias: 'upload' },
        created: true,
      });
    });

    it('falls back to HTTP 201 when the body has no created field (status-split server)', async () => {
      fetchMock.mockResolvedValue(mockResponse(201, { data: { keyAlias: 'upload' } }));
      await expect(
        putSecret(client, 'org_1', 'androidSigningKey', 'com.x', { keyAlias: 'upload' }),
      ).resolves.toEqual({
        data: { keyAlias: 'upload' },
        created: true,
      });
    });

    it('returns the WINNER data on a get-or-create hit, not the submitted data', async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: { keyAlias: 'winner' }, created: false }));
      const result = await putSecret(client, 'org_1', 'androidSigningKey', 'com.x', { keyAlias: 'loser' });
      expect(result).toEqual({ data: { keyAlias: 'winner' }, created: false });
    });

    it('rejects validation failures with the API message', async () => {
      fetchMock.mockResolvedValue(mockResponse(400, { message: 'keystoreBase64 is required' }));
      await expect(putSecret(client, 'org_1', 'androidSigningKey', 'com.x', {})).rejects.toThrow(
        /keystoreBase64 is required/,
      );
    });
  });
});
