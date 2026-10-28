import Limrun, { type BuildUpload } from '../src';
import { normalizeAssetUpload } from '../src/lib/asset-permissions';

test('signed URLs add no grants and do not activate workload authorization', () => {
  const upload = { signedUploadUrl: 'https://storage.example/upload' };
  expect(normalizeAssetUpload(upload)).toBeUndefined();
});

test.each(['*', 'name/*', 'name/', 'name/a%2fb', 'asset_invalid'])(
  'rejects ambiguous or noncanonical upload target %s',
  (target) => {
    expect(() => normalizeAssetUpload({ target })).toThrow();
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
  '%s sends the literal permissions unchanged in the instance creation body',
  async (resource) => {
    const calls: { url: string; body: unknown }[] = [];
    const client = new Limrun({
      apiKey: 'caller-key',
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return Response.json({ metadata: { id: 'instance' }, spec: {}, status: {} });
      },
    });
    await client[resource].create({
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

test('legacy names retain canonical encoding while literal targets pass through unchanged', () => {
  expect(normalizeAssetUpload({ assetName: "release/a:b *!'()~.apk" })?.target).toBe(
    'name/release%2Fa%3Ab%20%2A%21%27%28%29~.apk',
  );
  expect(normalizeAssetUpload({ target: 'name/release%2Fa%3Ab%20%2A.apk' })?.target).toBe(
    'name/release%2Fa%3Ab%20%2A.apk',
  );
});
