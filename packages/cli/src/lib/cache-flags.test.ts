import { Parser } from '@oclif/core';
import { snapshotFlags, waitSnapshotFlag } from './cache-flags';
import { parseSnapshotConfig } from './cache';

test.each(['snapshot', 'cache'])('%s flags produce the same configuration', async (name) => {
  const { flags } = await Parser.parse(
    [
      `--${name}-key`,
      'myapp-pr51',
      `--${name}-restore-keys`,
      'myapp-pr51,myapp-main',
      `--${name}-paths`,
      'Pods,.build',
    ],
    { flags: snapshotFlags },
  );
  expect(flags['snapshot-key']).toBe('myapp-pr51');
  expect(parseSnapshotConfig(flags)).toEqual({
    key: 'myapp-pr51',
    restoreKeys: ['myapp-pr51', 'myapp-main'],
    paths: ['Pods', '.build'],
  });
});

test.each(['--wait-snapshot', '--wait-cache'])('%s waits for publication', async (flag) => {
  const { flags } = await Parser.parse([flag], { flags: { 'wait-snapshot': waitSnapshotFlag } });
  expect(flags['wait-snapshot']).toBe(true);
});

test('legacy and snapshot spellings can be mixed across distinct options', async () => {
  const { flags } = await Parser.parse(['--cache-key', 'myapp-pr51', '--snapshot-restore-keys=myapp-main'], {
    flags: snapshotFlags,
  });
  expect(parseSnapshotConfig(flags)).toEqual({ key: 'myapp-pr51', restoreKeys: ['myapp-main'] });
});
