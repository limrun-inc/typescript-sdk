import fs from 'fs';
import os from 'os';
import path from 'path';
import Limrun from '@limrun/api';

import {
  type BazelSetup,
  bazelTooOld,
  bazelCredentials,
  detectWorkspaceKinds,
  getBazelSetup,
  missingAndroidModuleLines,
  appendModuleLines,
  renderPlaneBazelrc,
  writePlaneWorkspaceFiles,
} from './bazel-setup';

const setup: BazelSetup = {
  endpoint: 'grpcs://buildplane.eu-north1.limrun.net:4443',
  instanceName: 'org_01h455vb4pex5vsknk084sn02q',
  region: 'eu-north1',
  xcodeVersions: ['26.4.0.17E192'],
  linuxToolchains: 'jdk-17-21-25-v1',
};

function workspace(module: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-bazel-setup-'));
  fs.writeFileSync(path.join(dir, 'MODULE.bazel'), module);
  return dir;
}

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('workspace kinds', () => {
  it('reads the rules the root module depends on', () => {
    expect(
      detectWorkspaceKinds(workspace('bazel_dep(name = "rules_apple", version = "4.0.0")')),
    ).toMatchObject({
      apple: true,
      android: false,
    });
    expect(
      detectWorkspaceKinds(workspace('bazel_dep(\n    name = "rules_android",\n    version = "0.8.0",\n)')),
    ).toMatchObject({ apple: false, android: true });
    expect(detectWorkspaceKinds(workspace('# bazel_dep(name = "rules_cc")'))).toMatchObject({
      apple: false,
      android: false,
    });
  });
});

describe('MODULE.bazel lines for Android', () => {
  it('names only what the module lacks, and nothing once added', () => {
    const dir = workspace(
      'bazel_dep(name = "rules_android", version = "0.8.0")\nbazel_dep(name = "rules_cc", version = "0.2.17")\n',
    );
    const lines = missingAndroidModuleLines(dir);
    expect(lines).toContain('hermetic_android_toolchains');
    expect(lines).toContain('name = "protobuf"');
    expect(lines).not.toContain('name = "rules_cc"');
    appendModuleLines(dir, lines);
    expect(missingAndroidModuleLines(dir)).toBe('');
  });
});

describe('plane bazelrc', () => {
  it('reaches the plane with the credential helper and never a token', () => {
    const rc = renderPlaneBazelrc(setup, { apple: true, android: false }, true, 9);
    expect(rc).toContain('build:limrun --remote_executor=grpcs://buildplane.eu-north1.limrun.net:4443');
    expect(rc).toContain('build:limrun --remote_instance_name=org_01h455vb4pex5vsknk084sn02q');
    expect(rc).toContain(
      'build:limrun --credential_helper=buildplane.eu-north1.limrun.net=lim-bazel-credentials',
    );
    expect(rc).toContain('build:limrun --remote_default_exec_properties=OSFamily=macos');
    expect(rc).toContain('build:limrun --xcode_version=26.4');
    expect(rc).not.toMatch(/lim_st_|Authorization|remote_header/);
  });

  it('routes Android actions to Linux workers first', () => {
    const rc = renderPlaneBazelrc(setup, { apple: false, android: true }, true, 9);
    expect(rc).toContain(
      'common:limrun --extra_execution_platforms=//.limrun:linux_x86_64,//.limrun:macos_arm64',
    );
    expect(rc).toContain('bootstrap_impl=script');
    expect(rc).not.toContain('xcode_version');
    expect(rc).not.toContain('remote_default_exec_properties');
  });

  it("keeps a workspace's own Java runtime", () => {
    const own = renderPlaneBazelrc(setup, { apple: false, android: true, javaRuntime: true }, true, 9);
    expect(own).not.toContain('java_runtime_version');
    const dir = workspace('bazel_dep(name = "rules_android", version = "0.8.0")\n');
    fs.writeFileSync(
      path.join(dir, '.bazelrc'),
      '# --java_runtime_version=8\nbuild --java_runtime_version=21\n',
    );
    expect(detectWorkspaceKinds(dir).javaRuntime).toBe(true);
    expect(renderPlaneBazelrc(setup, { apple: false, android: true }, true, 9)).toContain(
      'common:limrun --java_runtime_version=remotejdk_17',
    );
  });

  it('keeps Bazel before 9 starting, and refuses Bazel before 8', () => {
    const startup = 'startup --experimental_remote_repo_contents_cache';
    expect(renderPlaneBazelrc(setup, { apple: true, android: false }, true, 9)).toContain(startup);
    expect(renderPlaneBazelrc(setup, { apple: true, android: false }, true, null)).toContain(startup);
    expect(renderPlaneBazelrc(setup, { apple: true, android: false }, true, 8)).not.toContain(startup);
    expect(bazelTooOld(8)).toBeNull();
    expect(bazelTooOld(null)).toBeNull();
    expect(bazelTooOld(7)).toContain('needs Bazel 8 or later');
  });

  it('gives a Linux client a darwin platform for Apple toolchains', () => {
    expect(renderPlaneBazelrc(setup, { apple: true, android: false }, false, 9)).toContain(
      '--extra_execution_platforms=@build_bazel_apple_support//platforms:darwin_arm64',
    );
  });
});

describe('workspace files', () => {
  it('writes the Android platforms with the workers toolchains, and refreshes in place', () => {
    const dir = workspace('bazel_dep(name = "rules_android", version = "0.8.0")\n');
    const files = writePlaneWorkspaceFiles(dir, setup, { apple: false, android: true }, true);
    const build = fs.readFileSync(files.buildFile, 'utf8');
    expect(build).toContain('"limrun-toolchains": "jdk-17-21-25-v1"');
    expect(build).toContain('java_home = "/opt/java/%d" % v');
    expect(build).not.toContain('xcode_config');
    expect(build).toContain('toolchain = ":linux_cc"');
    expect(fs.existsSync(path.join(dir, '.limrun', 'linux_cc_toolchain_config.bzl'))).toBe(true);
    expect(files.bazelrcUpdated).toBe(true);

    // A refresh after the workspace drops Android leaves no stub behind and
    // the import in place.
    const again = writePlaneWorkspaceFiles(dir, setup, { apple: true, android: false }, true);
    expect(again.bazelrcUpdated).toBe(false);
    expect(fs.existsSync(path.join(dir, '.limrun', 'linux_cc_toolchain_config.bzl'))).toBe(false);
    expect(fs.readFileSync(again.buildFile, 'utf8')).toContain('xcode_config');
  });
});

describe('director and credentials', () => {
  let fetchMock: jest.SpyInstance;
  let client: Limrun;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    client = new Limrun({ apiKey: 'key', baseURL: 'https://api.example.test', maxRetries: 0 });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('asks for a region only when given one', async () => {
    fetchMock.mockResolvedValue(mockResponse(200, setup));
    await getBazelSetup(client, 'eu-north1');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://api.example.test/v1/bazel_setup?region=eu-north1',
    );
  });

  it('answers in the credential helper protocol', async () => {
    fetchMock.mockResolvedValue(
      mockResponse(200, { token: 'lim_st_abc', expiresAt: '2026-10-06T12:00:00Z', scopes: [] }),
    );
    expect(await bazelCredentials(client)).toEqual({
      headers: { Authorization: ['Bearer lim_st_abc'] },
      expires: '2026-10-06T12:00:00Z',
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.scopes).toEqual(['remotecache:*:all', 'remoteexecution:*:all']);
  });

  it('falls back to cache reads for a credential that may not build', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse(403, { message: 'scope remoteexecution:*:all is not held' }))
      .mockResolvedValueOnce(
        mockResponse(200, { token: 'lim_st_read', expiresAt: '2026-10-06T12:00:00Z', scopes: [] }),
      );
    const credentials = await bazelCredentials(client);
    expect(credentials.headers.Authorization).toEqual(['Bearer lim_st_read']);
    const body = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(body.scopes).toEqual(['remotecache:*:read']);
  });
});
