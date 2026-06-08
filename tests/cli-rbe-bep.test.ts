import { parseTopLevelIpaDigest } from '../packages/cli/src/lib/rbe-bep';

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

const REMOTE_URI = 'bytestream://127.0.0.1:8980/blobs/deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc/40960';

describe('parseTopLevelIpaDigest', () => {
  test('extracts the .ipa CAS digest from a bytestream URI', () => {
    const d = parseTopLevelIpaDigest(bep(REMOTE_URI), '//App:App');
    expect(d.hash).toBe('deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc');
    expect(d.sizeBytes).toBe(40960);
    expect(d.ipaName).toBe('App/App.ipa');
  });

  test('tolerates an optional instance-name segment before /blobs/', () => {
    const uri = 'bytestream://host:1234/some-instance/blobs/abcabcabc123/77';
    const d = parseTopLevelIpaDigest(bep(uri), '//App:App');
    expect(d.hash).toBe('abcabcabc123');
    expect(d.sizeBytes).toBe(77);
  });

  test('matches the //pkg shorthand against BEP\'s canonical //pkg:name label', () => {
    // BEP records //App:App even when the user built (and installs) //App.
    const d = parseTopLevelIpaDigest(bep(REMOTE_URI, '//App:App'), '//App');
    expect(d.hash).toBe('deadbeefcafe0000111122223333444455556666777788889999aaaabbbbcccc');
  });

  test('errors when the target was not built', () => {
    expect(() => parseTopLevelIpaDigest(bep(REMOTE_URI, '//App:App'), '//Other:Other')).toThrow(
      /No successful build of \/\/Other:Other/,
    );
  });

  test('errors when the output was downloaded locally (file:// URI, no remote digest)', () => {
    const local = bep('file:///Users/me/bazel-bin/App/App.ipa');
    expect(() => parseTopLevelIpaDigest(local, '//App:App')).toThrow(/downloaded locally/);
  });

  test('errors when there is no .ipa output for the target', () => {
    const noIpa = [
      { id: { namedSet: { id: '0' } }, namedSetOfFiles: { files: [{ name: 'App/App.txt', uri: REMOTE_URI }] } },
      {
        id: { targetCompleted: { label: '//App:App' } },
        completed: { success: true, outputGroup: [{ name: 'default', fileSets: [{ id: '0' }] }] },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    expect(() => parseTopLevelIpaDigest(noIpa, '//App:App')).toThrow(/No \.ipa output/);
  });

  test('resolves a .ipa nested in a child fileSet', () => {
    const nested = [
      { id: { namedSet: { id: 'child' } }, namedSetOfFiles: { files: [{ name: 'App/App.ipa', uri: REMOTE_URI }] } },
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
});
