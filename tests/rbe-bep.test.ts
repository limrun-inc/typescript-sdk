import { parseTopLevelIpaDigest, inspectBuildCompletion, RbeBepError } from '@limrun/api';

// A minimal BEP stream mirroring the validated shape:
// targetCompleted{label} -> outputGroup "default" -> fileSet id -> namedSet ->
// files[] with a bytestream:// URI carrying the CAS digest.
function bep(uri: string, label = '//App:App', ipaName = 'App/App.ipa'): string {
  return [
    { id: { targetConfigured: { label } } },
    { id: { namedSet: { id: '0' } }, namedSetOfFiles: { files: [{ name: ipaName, uri }] } },
    {
      id: { targetCompleted: { label, configuration: { id: 'abc' } } },
      completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: '0' }] }] },
    },
    { id: { buildFinished: {} } },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
}

const REMOTE_URI =
  'bytestream://127.0.0.1:8980/blobs/deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc/40960';

describe('parseTopLevelIpaDigest', () => {
  test('extracts the .ipa CAS digest from a bytestream URI', () => {
    const d = parseTopLevelIpaDigest(bep(REMOTE_URI), '//App:App');
    expect(d.hash).toBe('deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc');
    expect(d.sizeBytes).toBe(40960);
    expect(d.ipaName).toBe('App/App.ipa');
  });

  test('tolerates an optional instance-name segment before /blobs/', () => {
    const hash = 'abcabc1234567890abcabc1234567890abcabc1234567890abcabc1234567890';
    const uri = `bytestream://host:1234/some-instance/blobs/${hash}/77`;
    const d = parseTopLevelIpaDigest(bep(uri), '//App:App');
    expect(d.hash).toBe(hash);
    expect(d.sizeBytes).toBe(77);
  });

  test("matches the //pkg shorthand against BEP's canonical //pkg:name label", () => {
    // BEP records //App:App even when the user built (and installs) //App.
    const d = parseTopLevelIpaDigest(bep(REMOTE_URI, '//App:App'), '//App');
    expect(d.hash).toBe('deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc');
  });

  test('canonicalizes a label with trailing slashes', () => {
    const d = parseTopLevelIpaDigest(bep(REMOTE_URI, '//App:App'), '//App//');
    expect(d.hash).toBe('deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc');
  });

  test('errors when the target was not built', () => {
    expect(() => parseTopLevelIpaDigest(bep(REMOTE_URI, '//App:App'), '//Other:Other')).toThrow(
      /No successful build of \/\/Other:Other/,
    );
  });

  test('errors when the output was built locally (file:// URI, no remote digest)', () => {
    const local = bep('file:///Users/me/bazel-bin/App/App.ipa');
    expect(() => parseTopLevelIpaDigest(local, '//App:App')).toThrow(/built locally, not remotely executed/);
  });

  test('errors when there is no .ipa output for the target', () => {
    const noIpa = [
      {
        id: { namedSet: { id: '0' } },
        namedSetOfFiles: { files: [{ name: 'App/App.txt', uri: REMOTE_URI }] },
      },
      {
        id: { targetCompleted: { label: '//App:App' } },
        completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: '0' }] }] },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    expect(() => parseTopLevelIpaDigest(noIpa, '//App:App')).toThrow(/No \.ipa output/);
  });

  test('rejects a non-SHA256 (e.g. BLAKE3) digest with an actionable error', () => {
    // A BLAKE3 digest is not 64 hex chars; the sha256-keyed instance CAS can't
    // resolve it, so the parser must flag it instead of passing it through.
    const blake3 = bep('bytestream://127.0.0.1:8980/blobs/abcabcabcabcabcabcabcabcabcabcab/40960');
    expect(() => parseTopLevelIpaDigest(blake3, '//App:App')).toThrow(
      /non-SHA256 digest|--digest_function=sha256/,
    );
  });

  test('resolves a .ipa nested in a child fileSet', () => {
    const nested = [
      {
        id: { namedSet: { id: 'child' } },
        namedSetOfFiles: { files: [{ name: 'App/App.ipa', uri: REMOTE_URI }] },
      },
      { id: { namedSet: { id: 'root' } }, namedSetOfFiles: { files: [], fileSets: [{ id: 'child' }] } },
      {
        id: { targetCompleted: { label: '//App:App' } },
        completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: 'root' }] }] },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const d = parseTopLevelIpaDigest(nested, '//App:App');
    expect(d.sizeBytes).toBe(40960);
  });

  test('classifies BLAKE3 and local-only as terminal, missing target as transient', () => {
    const blake3 = bep('bytestream://127.0.0.1:8980/blobs/abcabcabcabcabcabcabcabcabcabcab/40960');
    try {
      parseTopLevelIpaDigest(blake3, '//App:App');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RbeBepError);
      expect((err as RbeBepError).kind).toBe('non-sha256');
      expect((err as RbeBepError).terminal).toBe(true);
    }
    try {
      parseTopLevelIpaDigest(bep('file:///tmp/App.ipa'), '//App:App');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RbeBepError).kind).toBe('local-only');
      expect((err as RbeBepError).terminal).toBe(true);
    }
    try {
      parseTopLevelIpaDigest(bep(REMOTE_URI, '//App:App'), '//Other');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as RbeBepError).kind).toBe('no-build');
      expect((err as RbeBepError).terminal).toBe(false);
    }
  });
});

describe('inspectBuildCompletion', () => {
  // The terminal BEP order is buildFinished -> buildToolLogs -> buildMetrics(lastMessage),
  // so completion gates on lastMessage, not on buildFinished being the last line.
  const stream = (events: object[]) => events.map((e) => JSON.stringify(e)).join('\n');

  test('is incomplete until the lastMessage event is flushed', () => {
    const midBuild = stream([
      { started: { uuid: 'inv-1' } },
      { id: { targetCompleted: { label: '//App:App' } }, completed: { success: true } },
      { id: { buildFinished: {} }, finished: { overallSuccess: true } },
    ]);
    const r = inspectBuildCompletion(midBuild);
    expect(r.complete).toBe(false);
    expect(r.invocationId).toBe('inv-1');
  });

  test('reports complete + success once lastMessage arrives after buildFinished', () => {
    const done = stream([
      { started: { uuid: 'inv-2' } },
      { id: { buildFinished: {} }, finished: { overallSuccess: true } },
      { id: { buildToolLogs: {} } },
      { id: { buildMetrics: {} }, lastMessage: true },
    ]);
    const r = inspectBuildCompletion(done);
    expect(r.complete).toBe(true);
    expect(r.success).toBe(true);
    expect(r.invocationId).toBe('inv-2');
  });

  test('reports a failed build as not successful', () => {
    const failed = stream([
      { started: { uuid: 'inv-3' } },
      { id: { buildFinished: {} }, finished: { overallSuccess: false, exitCode: { code: 1 } } },
      { id: { buildMetrics: {} }, lastMessage: true },
    ]);
    const r = inspectBuildCompletion(failed);
    expect(r.complete).toBe(true);
    expect(r.success).toBe(false);
  });

  test('reports success via the exit code name when overallSuccess is absent (proto3 omits it)', () => {
    const done = [
      { started: { uuid: 'inv-x' } },
      { id: { buildFinished: {} }, finished: { exitCode: { name: 'SUCCESS' } } },
      { id: { buildMetrics: {} }, lastMessage: true },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    const r = inspectBuildCompletion(done);
    expect(r.complete).toBe(true);
    expect(r.success).toBe(true);
  });
});

describe('parseTopLevelIpaDigest BLAKE3 handling', () => {
  test('rejects a BLAKE3 build (function segment in the bytestream URI) with the sha256 fix', () => {
    // Bazel 9 default: /blobs/blake3/<64hex>/<size>. The 64-hex hash is
    // indistinguishable from sha256 by length, so the function segment is what
    // catches it.
    const blake3Hash = 'b'.repeat(64);
    const blake3 = bep(`bytestream://127.0.0.1:8980/blobs/blake3/${blake3Hash}/40960`);
    try {
      parseTopLevelIpaDigest(blake3, '//App:App');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RbeBepError);
      expect((err as RbeBepError).kind).toBe('non-sha256');
      expect((err as Error).message).toMatch(/--digest_function=sha256/);
    }
  });

  test('still resolves the plain sha256 URI shape (no function segment)', () => {
    const d = parseTopLevelIpaDigest(bep(REMOTE_URI), '//App:App');
    expect(d.hash).toBe('deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc');
  });
});
