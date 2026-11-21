import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuthenticationError, PermissionDeniedError } from '@limrun/api';
import { isLoginRequiredError, loginWithOptions, readPendingLogin } from './auth';
import { type TelemetryCapture } from './telemetry';

function temporaryPendingLoginFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lim-login-')), 'pending-login.json');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('login-required errors', () => {
  const headers = new Headers();

  it('accepts standard authentication errors', () => {
    expect(isLoginRequiredError(new AuthenticationError(401, {}, undefined, headers))).toBe(true);
  });

  it('accepts unauthenticated responses returned as permission errors', () => {
    const error = new PermissionDeniedError(
      403,
      { message: 'unauthenticated: no such token found' },
      undefined,
      headers,
    );
    expect(isLoginRequiredError(error)).toBe(true);
  });

  it('rejects genuine permission errors', () => {
    const error = new PermissionDeniedError(403, { message: 'operation is not allowed' }, undefined, headers);
    expect(isLoginRequiredError(error)).toBe(false);
  });
});

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
      pendingLoginFile: temporaryPendingLoginFile(),
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
        pendingLoginFile: temporaryPendingLoginFile(),
      }),
    ).rejects.toThrow('database down');

    expect(telemetry).toHaveBeenNthCalledWith(2, 'cli_auth_failed', {
      auth_method: 'browser',
      error_category: 'unknown',
    });
  });
});

describe('resumable login', () => {
  const endpoints = {
    apiEndpoint: 'https://api.example.test',
    consoleEndpoint: 'https://console.example.test',
    version: '1.2.3',
    hostname: 'developer-laptop',
    anonymousId: 'anon',
    telemetry: jest.fn().mockResolvedValue(true),
    log: jest.fn(),
  };
  const inOneMinute = () => new Date(Date.now() + 60_000).toISOString();
  const session = (expiresAt: string) =>
    jsonResponse(201, {
      sessionId: 'session_1',
      secret: 'session-secret',
      phrase: 'amber river',
      verificationUrl: 'https://console.example.test/authn/cli?session=session_1',
      expiresAt,
      pollIntervalSeconds: 1,
    });
  const stored = (expiresAt: string) => ({
    sessionId: 'session_0',
    secret: 'stored-secret',
    phrase: 'quiet harbor',
    verificationUrl: 'https://console.example.test/authn/cli?session=session_0',
    expiresAt,
    pollIntervalSeconds: 1,
    apiEndpoint: 'https://api.example.test',
  });
  let pendingLoginFile: string;

  beforeEach(() => {
    pendingLoginFile = temporaryPendingLoginFile();
  });

  it('stores the session privately while waiting and removes it after approval', async () => {
    const expiresAt = inOneMinute();
    const onPending = jest.fn(() => {
      expect(fs.statSync(pendingLoginFile).mode & 0o777).toBe(0o600);
    });
    const configWriter = jest.fn();

    await loginWithOptions({
      ...endpoints,
      fetcher: jest
        .fn()
        .mockResolvedValueOnce(session(expiresAt))
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(jsonResponse(200, { apiKey: 'lim_api_key' })),
      configWriter,
      opener: jest.fn(),
      onPending,
      pendingLoginFile,
    });

    expect(onPending).toHaveBeenCalledWith({
      verificationUrl: 'https://console.example.test/authn/cli?session=session_1',
      phrase: 'amber river',
      expiresAt,
    });
    expect(configWriter).toHaveBeenCalledWith({ 'api-key': 'lim_api_key' });
    expect(fs.existsSync(pendingLoginFile)).toBe(false);
  });

  it('continues a stopped login with the same phrase instead of starting a new one', async () => {
    const expiresAt = inOneMinute();
    fs.writeFileSync(pendingLoginFile, JSON.stringify(stored(expiresAt)));
    const fetcher = jest.fn().mockResolvedValueOnce(jsonResponse(200, { apiKey: 'lim_api_key' }));
    const opener = jest.fn();
    const onPending = jest.fn();

    await loginWithOptions({
      ...endpoints,
      fetcher,
      configWriter: jest.fn(),
      opener,
      onPending,
      pendingLoginFile,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://api.example.test/authn/cli/sessions/session_0/token?secret=stored-secret',
    );
    expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ phrase: 'quiet harbor' }));
    expect(opener).not.toHaveBeenCalled();
  });

  it('starts a new login when the stored one has expired', async () => {
    fs.writeFileSync(pendingLoginFile, JSON.stringify(stored(new Date(Date.now() - 1_000).toISOString())));
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(session(inOneMinute()))
      .mockResolvedValueOnce(jsonResponse(200, { apiKey: 'lim_api_key' }));

    await loginWithOptions({
      ...endpoints,
      fetcher,
      configWriter: jest.fn(),
      opener: jest.fn(),
      pendingLoginFile,
    });

    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example.test/authn/cli/sessions');
  });

  it('drops the stored session when the backend expires it', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(session(inOneMinute()))
      .mockResolvedValueOnce(jsonResponse(410, { message: 'expired' }));

    await expect(
      loginWithOptions({ ...endpoints, fetcher, opener: jest.fn(), pendingLoginFile }),
    ).rejects.toThrow('expired');
    expect(readPendingLogin(pendingLoginFile)).toBeNull();
  });
});
