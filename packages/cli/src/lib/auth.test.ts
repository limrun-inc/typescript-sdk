import { loginWithOptions } from './auth';
import { type TelemetryCapture } from './telemetry';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CLI browser authentication telemetry', () => {
  it('carries the anonymous ID and records completion with the organization', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        jsonResponse(201, {
          sessionId: 'session_1',
          secret: 'session-secret',
          phrase: 'amber river',
          verificationUrl: 'https://console.example.test/authn/cli?session=session_1',
          expiresAt: '2026-08-04T12:00:00Z',
          pollIntervalSeconds: 1,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          apiKey: 'lim_api_key',
          organizationId: 'org_123',
        }),
      );
    const telemetry = jest
      .fn<ReturnType<TelemetryCapture>, Parameters<TelemetryCapture>>()
      .mockResolvedValue(true);
    const configWriter = jest.fn();

    await loginWithOptions({
      apiEndpoint: 'https://api.example.test',
      consoleEndpoint: 'https://console.example.test',
      version: '1.2.3',
      hostname: 'developer-laptop',
      anonymousId: '7cbf5b3d-a2bb-4b5f-92d7-48ec09e025f8',
      fetcher,
      telemetry,
      configWriter,
      opener: jest.fn(),
      log: jest.fn(),
    });

    const [, createInit] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(createInit?.body))).toEqual({
      hostname: 'developer-laptop',
      cliVersion: '1.2.3',
      anonymousId: '7cbf5b3d-a2bb-4b5f-92d7-48ec09e025f8',
    });
    expect(configWriter).toHaveBeenCalledWith({ 'api-key': 'lim_api_key' });
    expect(telemetry).toHaveBeenNthCalledWith(1, 'cli_auth_started', {
      auth_method: 'browser',
    });
    expect(telemetry).toHaveBeenCalledTimes(1);
  });

  it('records a categorized failure without changing the login error', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse(500, { message: 'database down' }));
    const telemetry = jest
      .fn<ReturnType<TelemetryCapture>, Parameters<TelemetryCapture>>()
      .mockResolvedValue(true);

    await expect(
      loginWithOptions({
        apiEndpoint: 'https://api.example.test',
        consoleEndpoint: 'https://console.example.test',
        version: '1.2.3',
        hostname: 'developer-laptop',
        anonymousId: '7cbf5b3d-a2bb-4b5f-92d7-48ec09e025f8',
        fetcher,
        telemetry,
        opener: jest.fn(),
        log: jest.fn(),
      }),
    ).rejects.toThrow('database down');

    expect(telemetry).toHaveBeenNthCalledWith(2, 'cli_auth_failed', {
      auth_method: 'browser',
      error_category: 'unknown',
    });
  });
});
