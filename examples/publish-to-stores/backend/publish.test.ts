import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSigningArguments, resolvePublishCredentials } from './publish.js';
import { putSecret } from './secret-store.js';

const teamId = 'TEAM123456';
const bundleId = 'com.example.app';

async function withSecrets(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'publish-signing-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('cloud signing resolves only the App Store Connect API key', async () => {
  await withSecrets(async (dir) => {
    await putSecret(
      'appStoreConnectApiKey',
      `${teamId}/APP_STORE_CONNECT_API_KEY`,
      { keyId: 'KEY123', issuerId: 'issuer-id', privateKeyP8Base64: 'a2V5' },
      dir,
    );

    const credentials = await resolvePublishCredentials(teamId, bundleId, 'cloud', dir);
    assert.equal(credentials.signingMode, 'cloud');
    assert.equal(credentials.apiKey.data.keyId, 'KEY123');
  });
});

test('manual signing requires and resolves stored certificate and profile', async () => {
  await withSecrets(async (dir) => {
    await putSecret(
      'appStoreConnectApiKey',
      `${teamId}/APP_STORE_CONNECT_API_KEY`,
      { keyId: 'KEY123', privateKeyP8Base64: 'a2V5' },
      dir,
    );
    await assert.rejects(
      resolvePublishCredentials(teamId, bundleId, 'manual', dir),
      /No distribution certificate/,
    );

    await putSecret(
      'appleCertificate',
      `${teamId}/DISTRIBUTION`,
      {
        certificateP12Base64: 'cDEy',
        certificatePassword: 'secret',
        serialNumber: 'CERT123',
        expirationDate: '2000-01-01T00:00:00Z',
      },
      dir,
    );
    await putSecret(
      'appleProvisioningProfile',
      `${teamId}/PROFILE`,
      {
        teamID: teamId,
        bundleIDs: ` ${bundleId} `,
        certificateSerialNumbers: 'OTHER',
        expirationDate: '2100-01-01T00:00:00Z',
        provisioningProfileBase64: 'cHJvZmlsZQ==',
      },
      dir,
    );
    await assert.rejects(resolvePublishCredentials(teamId, bundleId, 'manual', dir), /certificate.*expired/i);

    await putSecret(
      'appleCertificate',
      `${teamId}/DISTRIBUTION`,
      {
        certificateP12Base64: 'cDEy',
        certificatePassword: 'secret',
        serialNumber: 'CERT123',
        expirationDate: '2100-01-01T00:00:00Z',
      },
      dir,
    );
    await assert.rejects(
      resolvePublishCredentials(teamId, bundleId, 'manual', dir),
      /matches the distribution/,
    );

    await putSecret(
      'appleProvisioningProfile',
      `${teamId}/PROFILE`,
      {
        teamID: teamId,
        bundleIDs: ` ${bundleId} `,
        certificateSerialNumbers: 'CERT123',
        expirationDate: '2100-01-01T00:00:00Z',
        provisioningProfileBase64: 'cHJvZmlsZQ==',
      },
      dir,
    );

    const credentials = await resolvePublishCredentials(teamId, bundleId, 'manual', dir);
    assert.equal(credentials.signingMode, 'manual');
    assert.equal(credentials.certificate.data.certificatePassword, 'secret');
    assert.equal(credentials.profile.data.bundleIDs.trim(), bundleId);
  });
});

test('build arguments keep cloud and manual signing mutually exclusive', () => {
  const cloud = buildSigningArguments({
    signingMode: 'cloud',
    teamId,
    apiKeyId: 'KEY123',
    apiIssuerId: 'issuer-id',
    apiKeyPath: '/tmp/AuthKey.p8',
  });
  assert.ok(cloud.includes('--signing-method'));
  assert.ok(!cloud.includes('--certificate-p12'));

  const manual = buildSigningArguments({
    signingMode: 'manual',
    teamId,
    apiKeyId: 'KEY123',
    apiKeyPath: '/tmp/AuthKey.p8',
    certificatePath: '/tmp/certificate.p12',
    certificatePassword: 'secret',
    profilePath: '/tmp/profile.mobileprovision',
  });
  assert.ok(manual.includes('--certificate-p12'));
  assert.ok(manual.includes('--provisioning-profile'));
  assert.ok(!manual.includes('--signing-method'));
  assert.ok(cloud.includes('--upload-to-appstore'));
  assert.ok(manual.includes('--upload-to-appstore'));
});
