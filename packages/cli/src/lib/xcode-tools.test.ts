import { Parser } from '@oclif/core';
import XcodeUse from '../commands/xcode/use';
import XcodeTools from '../commands/xcode/tools';

it('parses multiple tool requests alongside scope flags', async () => {
  const result = await Parser.parse(['--global', '--cwd', 'apps/mobile', 'node@24', 'ruby@3.3'], {
    flags: XcodeUse.flags,
    args: XcodeUse.args,
    strict: XcodeUse.strict,
  });
  expect(result.argv).toEqual(['node@24', 'ruby@3.3']);
  expect(result.flags.global).toBe(true);
  expect(result.flags.cwd).toBe('apps/mobile');
});

it('supports inspecting an existing workspace without sync', async () => {
  const result = await Parser.parse(['--no-sync', '--cwd', 'apps/mobile'], { flags: XcodeTools.flags });
  expect(result.flags['no-sync']).toBe(true);
  expect(result.flags.cwd).toBe('apps/mobile');
});
