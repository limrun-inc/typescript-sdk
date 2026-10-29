import Limrun, { type BuildUpload } from '../src';
import { normalizeAssetUpload } from '../src/lib/asset-permissions';

test('signed URLs add no grants and do not activate workload authorization', () => {
  const upload = { signedUploadUrl: 'https://storage.example/upload' };
  expect(normalizeAssetUpload(upload)).toEqual(upload);
});

test.each(['*', 'name/', 'asset_invalid'])('rejects invalid upload target %s', (target) => {
  expect(() => normalizeAssetUpload({ target })).toThrow();
});

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
            'asset:name/releases:prod/app%2F.apk:create',
            'asset:name/releases:prod/app%2F.apk:upload',
            'asset:name/releases:prod/app%2F.apk:update',
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
            'asset:name/releases:prod/app%2F.apk:create',
            'asset:name/releases:prod/app%2F.apk:upload',
            'asset:name/releases:prod/app%2F.apk:update',
          ],
        },
      },
    });
    expect(calls[0]!.url).not.toContain('/assets');
  },
);

test.each(["release/a:b *!'()~.apk", 'a%2Fb', 'a%2fb', '%', '*', 'name/app.ipa', ':a:', '日本.apk'])(
  'legacy names and literal targets preserve the exact name %s',
  (name) => {
    const target = `name/${name}`;
    expect(normalizeAssetUpload({ assetName: name }).assetUpload?.target).toBe(target);
    expect(normalizeAssetUpload({ target }).assetUpload?.target).toBe(target);
  },
);
