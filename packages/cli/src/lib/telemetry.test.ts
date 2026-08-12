import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  captureTelemetry,
  getOrCreateInstallationId,
  sanitizeTelemetryProperties,
  telemetryIntentForCommand,
} from './telemetry';

const UUID = '7cbf5b3d-a2bb-4b5f-92d7-48ec09e025f8';

describe('CLI telemetry', () => {
  let tempDir: string;
  let previousDisableTelemetry: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-telemetry-test-'));
    previousDisableTelemetry = process.env['LIM_DISABLE_TELEMETRY'];
    delete process.env['LIM_DISABLE_TELEMETRY'];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousDisableTelemetry === undefined) {
      delete process.env['LIM_DISABLE_TELEMETRY'];
    } else {
      process.env['LIM_DISABLE_TELEMETRY'] = previousDisableTelemetry;
    }
  });

  it('persists one stable random installation ID', () => {
    const filePath = path.join(tempDir, 'telemetry.json');
    const uuid = jest.fn(() => UUID);

    expect(getOrCreateInstallationId({ filePath, uuid })).toBe(UUID);
    expect(getOrCreateInstallationId({ filePath, uuid })).toBe(UUID);
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      installationId: UUID,
    });
  });

  it('is a no-op when configuration is unavailable or telemetry is disabled', async () => {
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
    const filePath = path.join(tempDir, 'telemetry.json');

    await expect(captureTelemetry('cli_auth_started', {}, { fetcher, filePath })).resolves.toBe(false);
    process.env['LIM_DISABLE_TELEMETRY'] = '1';
    await expect(
      captureTelemetry(
        'cli_auth_started',
        {},
        {
          endpoint: 'https://us.i.posthog.com',
          projectKey: 'phc_public',
          fetcher,
          filePath,
        },
      ),
    ).resolves.toBe(false);

    expect(fetcher).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('fails open on network errors', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('offline'));

    await expect(
      captureTelemetry(
        'skills_install_started',
        { entrypoint: 'skills_command' },
        {
          endpoint: 'https://us.i.posthog.com',
          projectKey: 'phc_public',
          fetcher,
          installationId: UUID,
        },
      ),
    ).resolves.toBe(false);
  });

  it('bounds delivery even when the network call never settles', async () => {
    const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
      () => new Promise<Response>(() => {}),
    );

    await expect(
      captureTelemetry(
        'build_requested',
        { build_system: 'xcode' },
        {
          endpoint: 'https://us.i.posthog.com',
          projectKey: 'phc_public',
          fetcher,
          installationId: UUID,
          timeoutMs: 5,
        },
      ),
    ).resolves.toBe(false);
  });

  it('redacts sensitive names and values while preserving coarse properties', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const properties = sanitizeTelemetryProperties({
      entrypoint: 'onboarding',
      skill_count: 2,
      api_key: 'lim_secret',
      repository: 'limrun/private',
      project_path: '/Users/alice/private-project',
      contact: 'alice@example.com',
      documentation: 'https://private.example.test',
    });

    expect(properties).toEqual({ entrypoint: 'onboarding', skill_count: 2 });

    await captureTelemetry(
      'instance_create_requested',
      {
        ...properties,
        organization_tid: 'org_123',
      },
      {
        endpoint: 'https://us.i.posthog.com',
        projectKey: 'phc_public',
        fetcher,
        installationId: UUID,
      },
    );

    const [, init] = fetcher.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as {
      api_key: string;
      event: string;
      properties: Record<string, unknown>;
    };
    expect(body.api_key).toBe('phc_public');
    expect(body.event).toBe('instance_create_requested');
    expect(body.properties).toMatchObject({
      distinct_id: UUID,
      schema_version: 1,
      source: 'cli',
      entrypoint: 'onboarding',
      skill_count: 2,
      organization_tid: 'org_123',
      $groups: { organization: 'org_123' },
    });
    expect(JSON.stringify(body.properties)).not.toContain('lim_secret');
    expect(JSON.stringify(body.properties)).not.toContain('/Users/alice');
  });

  it('keeps only coarse lim run lifecycle properties', () => {
    expect(
      sanitizeTelemetryProperties({
        project_kind: 'expo',
        flow: 'existing_project',
        quiet: false,
        duration_ms: 1234,
        failure_stage: 'build',
        error_category: 'validation',
        project_path: '/Users/alice/private-project',
        error_message: '/Users/alice/private-project failed with a secret',
      }),
    ).toEqual({
      project_kind: 'expo',
      flow: 'existing_project',
      quiet: false,
      duration_ms: 1234,
      failure_stage: 'build',
      error_category: 'validation',
    });
  });

  it('reduces create and build command hooks to high-level intent', () => {
    expect(
      telemetryIntentForCommand('ios:create', {
        region: 'private-region-value',
        xcode: true,
        'reuse-if-exists': true,
        install: ['/Users/alice/private.ipa'],
      }),
    ).toEqual({
      event: 'instance_create_requested',
      properties: {
        platform: 'ios',
        create_kind: 'ios_with_xcode',
        region_selected: true,
        reuse_requested: true,
      },
    });
    expect(
      telemetryIntentForCommand('xcode:build', {
        id: 'sandbox_secret',
        path: '/Users/alice/private-project',
        detach: true,
      }),
    ).toEqual({
      event: 'build_requested',
      properties: {
        build_system: 'xcode',
        detached: true,
        explicit_target: true,
      },
    });
  });
});
