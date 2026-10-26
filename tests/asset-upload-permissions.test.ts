import Limrun, { assetNameTarget, assetUploadPermissions, type BuildUpload } from '../src';
import { normalizeAssetUpload } from '../src/lib/asset-permissions';

test('upload grants are additive, exact, deduplicated, and do not mutate the supplied grants', () => {
  const target = assetNameTarget('releases/app:*.ipa');
  const existing = ['asset:name/input.zip:read', `asset:${target}:upload`];
  const before = [...existing];
  expect(assetUploadPermissions({ target }, existing)).toEqual([
    ...existing,
    `asset:${target}:create`,
    `asset:${target}:update`,
  ]);
  expect(existing).toEqual(before);
  expect(target).toBe('name/releases%2Fapp%3A%2A.ipa');
});

test('ID uploads never receive create or wildcard grants', () => {
  const id = 'asset_01h455vb4pex5vsknk084sn02q';
  expect(assetUploadPermissions({ target: id })).toEqual([`asset:${id}:upload`, `asset:${id}:update`]);
});

test('signed URLs add no grants and do not activate workload authorization', () => {
  const upload = { signedUploadUrl: 'https://storage.example/upload' };
  expect(normalizeAssetUpload(upload)).toBeUndefined();
  expect(assetUploadPermissions(upload, ['asset:name/input.zip:read'])).toEqual([
    'asset:name/input.zip:read',
  ]);
  expect(assetUploadPermissions(upload)).toEqual([]);
});

test.each(['*', 'name/*', 'name/', 'name/a%2fb', 'asset_invalid'])(
  'rejects ambiguous or noncanonical upload target %s',
  (target) => {
    expect(() => assetUploadPermissions({ target })).toThrow();
  },
);

test('conflicting authorization modes fail before making a request', () => {
  expect(() =>
    normalizeAssetUpload({
      target: 'name/app.apk',
      signedUploadUrl: 'https://storage.example/upload',
    } as unknown as BuildUpload),
  ).toThrow('exactly one');
});

test.each(['iosInstances', 'androidInstances', 'xcodeInstances', 'gradleInstances'] as const)(
  '%s sends the cumulative permissions in the instance creation body',
  async (resource) => {
    const calls: { url: string; body: unknown }[] = [];
    const client = new Limrun({
      apiKey: 'caller-key',
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return Response.json({ metadata: { id: 'instance' }, spec: {}, status: {} });
      },
    });
    const upload = { target: assetNameTarget('result.apk') };
    await client[resource].create({
      spec: { role: { permissions: assetUploadPermissions(upload, ['asset:name/input.zip:read']) } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      spec: {
        role: {
          permissions: [
            'asset:name/input.zip:read',
            'asset:name/result.apk:create',
            'asset:name/result.apk:upload',
            'asset:name/result.apk:update',
          ],
        },
      },
    });
    expect(calls[0]!.url).not.toContain('/assets');
  },
);
