jest.mock('eventsource-client', () => ({
  createEventSource: jest.fn((options: { onMessage: (message: { event: string; data: string }) => void }) => {
    setTimeout(() => options.onMessage({ event: 'exitCode', data: '0' }), 0);
    return { close: jest.fn() };
  }),
}));

import Limrun from '@limrun/api';
import { nodeProxyTransport } from '@limrun/api/internal/proxy-transport';
import type { RequestInfo } from '../src/internal/builtin-types';

const originalFetch = nodeProxyTransport.fetch;

describe('xcode client signing', () => {
  afterEach(() => {
    nodeProxyTransport.fetch = originalFetch;
  });

  test('serializes the multi-profile signing config verbatim', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/exec') {
        return jsonResponse({ execId: 'build-1' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });

    const result = await xcode.xcodebuild(
      { sdk: 'iphoneos' },
      {
        signing: {
          certificateP12Base64: 'cert',
          certificatePassword: 'pw',
          provisioningProfilesBase64: ['widget-profile', 'app-profile'],
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { sdk: 'iphoneos' },
      signing: {
        certificateP12Base64: 'cert',
        certificatePassword: 'pw',
        provisioningProfilesBase64: ['widget-profile', 'app-profile'],
      },
    });
  });

  test('serializes cloud signing with automatic App Store build numbering', async () => {
    const calls: Array<{ input: RequestInfo; init: RequestInit | undefined }> = [];
    nodeProxyTransport.fetch = jest.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({ input, init });
      if (String(input) === 'https://xcode.example.test/exec') {
        return jsonResponse({ execId: 'build-2' });
      }
      throw new Error(`unexpected request: ${input}`);
    });

    const client = new Limrun({ apiKey: 'key' });
    const xcode = await client.xcodeInstances.createClient({
      apiUrl: 'https://xcode.example.test',
      token: 'xcode-token',
    });
    const result = await xcode.xcodebuild(
      { sdk: 'iphoneos', configuration: 'Release' },
      {
        cloudSigning: {
          method: 'app-store-connect',
          teamId: 'TEAM123456',
          apiKeyId: 'KEY123',
          apiIssuerId: 'issuer-uuid',
          apiPrivateKeyBase64: 'private-key',
        },
        appstore: {
          apiKeyId: 'KEY123',
          apiIssuerId: 'issuer-uuid',
          apiPrivateKeyBase64: 'private-key',
          autoIncrementBuildNumber: true,
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      command: 'xcodebuild',
      xcodebuild: { sdk: 'iphoneos', configuration: 'Release' },
      cloudSigning: {
        method: 'app-store-connect',
        teamId: 'TEAM123456',
        apiKeyId: 'KEY123',
        apiIssuerId: 'issuer-uuid',
        apiPrivateKeyBase64: 'private-key',
      },
      testflight: {
        apiKeyId: 'KEY123',
        apiIssuerId: 'issuer-uuid',
        apiPrivateKeyBase64: 'private-key',
        autoIncrementBuildNumber: true,
      },
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
