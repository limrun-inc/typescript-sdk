import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveApplicationId, saveProvidedKey } from './gradle-signing';
import * as backend from './backend';

describe('resolveApplicationId', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-sign-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers the explicit flag over any detection', () => {
    fs.writeFileSync(
      path.join(dir, 'app.json'),
      JSON.stringify({ expo: { android: { package: 'com.expo' } } }),
    );
    expect(resolveApplicationId({ explicit: 'com.flag', syncPath: dir })).toBe('com.flag');
  });

  it('reads the Expo android package, honoring --expo-app-dir', () => {
    const appDir = path.join(dir, 'apps/mobile');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, 'app.json'),
      JSON.stringify({ expo: { android: { package: 'com.expo' } } }),
    );
    expect(resolveApplicationId({ syncPath: dir, expoAppDir: 'apps/mobile' })).toBe('com.expo');
  });

  it('falls back to app/build.gradle in Groovy form', () => {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'app/build.gradle'),
      'android {\n  defaultConfig {\n    applicationId "com.groovy"\n  }\n}\n',
    );
    expect(resolveApplicationId({ syncPath: dir })).toBe('com.groovy');
  });

  it('parses the Kotlin DSL form, honoring --project-path', () => {
    fs.mkdirSync(path.join(dir, 'android/app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'android/app/build.gradle.kts'), 'applicationId = "com.kts"\n');
    expect(resolveApplicationId({ syncPath: dir, projectPath: 'android' })).toBe('com.kts');
  });

  it('asks for --application-id when nothing is detectable', () => {
    expect(() => resolveApplicationId({ syncPath: dir })).toThrow(/--application-id/);
  });
});

describe('saveProvidedKey', () => {
  const provided = {
    keystoreBase64: 'a2V5c3RvcmU=',
    keystorePassword: 'store',
    keyAlias: 'upload',
    keyPassword: 'key',
  };

  afterEach(() => jest.restoreAllMocks());

  it('escrows a new key', async () => {
    jest.spyOn(backend, 'whoAmI').mockResolvedValue({ organizationId: 'org_1' });
    const put = jest.spyOn(backend, 'putSecret').mockResolvedValue({ data: { ...provided }, created: true });
    await expect(saveProvidedKey('https://api', 'key', 'com.x', provided)).resolves.toEqual({
      created: true,
    });
    expect(put).toHaveBeenCalledWith('https://api', 'key', 'org_1', 'androidSigningKey', 'com.x', provided);
  });

  it('accepts an identical already-escrowed key', async () => {
    jest.spyOn(backend, 'whoAmI').mockResolvedValue({ organizationId: 'org_1' });
    jest.spyOn(backend, 'putSecret').mockResolvedValue({ data: { ...provided }, created: false });
    await expect(saveProvidedKey('https://api', 'key', 'com.x', provided)).resolves.toEqual({
      created: false,
    });
  });

  it('hard-fails when a DIFFERENT key is already escrowed', async () => {
    jest.spyOn(backend, 'whoAmI').mockResolvedValue({ organizationId: 'org_1' });
    jest
      .spyOn(backend, 'putSecret')
      .mockResolvedValue({ data: { ...provided, keystoreBase64: 'b3RoZXI=' }, created: false });
    await expect(saveProvidedKey('https://api', 'key', 'com.x', provided)).rejects.toThrow(
      /already has a different upload key/,
    );
  });
});
