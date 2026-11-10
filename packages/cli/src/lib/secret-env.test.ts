import { parseSecretEnv, parseSecretFiles, permissionCovers, secretReadPermissions } from './secret-env';
import { delegatedPermissionsFromFlags } from './delegated-permissions';

test('literal names preserve slashes and colons, with exact read grants', () => {
  const bindings = parseSecretEnv([
    'NPM_TOKEN=team/npm:production',
    'PAT=name/github/private',
    'ID=secret_01m7071h5qfavacqmm4mg23x1k',
  ]);
  expect(bindings).toEqual({
    NPM_TOKEN: 'name/team/npm:production',
    PAT: 'name/github/private',
    ID: 'secret_01m7071h5qfavacqmm4mg23x1k',
  });
  expect(secretReadPermissions(bindings)).toEqual([
    'secret:name/team/npm:production:read',
    'secret:name/github/private:read',
    'secret:secret_01m7071h5qfavacqmm4mg23x1k:read',
  ]);
  expect(
    delegatedPermissionsFromFlags({
      'env-from-secret': ['NPM_TOKEN=team/npm'],
      permission: ['asset:name/source:read'],
    }),
  ).toEqual(['asset:name/source:read', 'secret:name/team/npm:read']);
});

test.each([
  'TOKEN=*',
  'TOKEN=team/?',
  'TOKEN=',
  'BAD-KEY=name',
  'PATH=path',
  'LIMRUN_WORKLOAD_IDENTITY_TOKEN_FILE=token',
  'TOKEN=name/',
])('rejects invalid binding %s', (entry) => {
  expect(() => parseSecretEnv([entry])).toThrow();
});

test('rejects duplicate variables instead of silently granting the wrong secret', () => {
  expect(() => parseSecretEnv(['TOKEN=one', 'TOKEN=two'])).toThrow('Duplicate');
});

test('already-delegated wildcard permissions avoid unnecessary role updates', () => {
  expect(permissionCovers('secret:*:read', 'secret:name/team/npm:read')).toBe(true);
  expect(permissionCovers('secret:name/team/*:all', 'secret:name/team/npm:read')).toBe(true);
  expect(permissionCovers('secret:name/team/*:write', 'secret:name/team/npm:read')).toBe(false);
  expect(permissionCovers('asset:*:all', 'secret:name/team/npm:read')).toBe(false);
  expect(permissionCovers('secret:name/team/a.b:read', 'secret:name/team/a+b:read')).toBe(false);
  expect(permissionCovers('secret:name/team/npm:read', 'secret:name/team/npm:production:read')).toBe(false);
});

test('file bindings keep remote home paths and delegate exact secret names', () => {
  expect(parseSecretFiles(['~/.npmrc=packages/npm:prod', 'config/token=team/service'])).toEqual({
    '~/.npmrc': 'name/packages/npm:prod',
    'config/token': 'name/team/service',
  });
  expect(delegatedPermissionsFromFlags({ 'file-from-secret': ['~/.npmrc=packages/npm'] })).toEqual([
    'secret:name/packages/npm:read',
  ]);
});
test.each([
  '/=key',
  '/~/token=key',
  '/../../token=key',
  '../token=key',
  '~/.config/../token=key',
  '~/=key',
  'a//b=key',
  '~/.npmrc=*',
])('rejects unsafe secret file %s', (entry) => {
  expect(() => parseSecretFiles([entry])).toThrow();
});

test('secret files normalize leading slashes and reject duplicate aliases', () => {
  expect(parseSecretFiles(['/etc/var=one', '~/.npmrc=two'])).toEqual({
    'etc/var': 'name/one',
    '~/.npmrc': 'name/two',
  });
  expect(() => parseSecretFiles(['/etc/var=one', 'etc/var=two'])).toThrow('Duplicate');
});

test.each(['*', '', 'name/'])('file binding errors name the file flag for target %s', (target) => {
  expect(() => parseSecretFiles([`~/.npmrc=${target}`])).toThrow('--file-from-secret');
});
