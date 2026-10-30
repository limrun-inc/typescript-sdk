import XcodeList from './list';
import XcodeGet from './get';
import XcodeDelete from './delete';
import IOSList from '../../ios/snapshot/list';
import IOSGet from '../../ios/snapshot/get';
import IOSDelete from '../../ios/snapshot/delete';
import { whoAmI } from '../../../lib/backend';
import { snapshotResource } from '../../../lib/snapshots';

jest.mock('../../../lib/snapshots', () => ({ snapshotResource: jest.fn() }));
jest.mock('../../../lib/backend', () => ({ whoAmI: jest.fn(async () => 'org_default') }));

describe.each([
  { kind: 'xcode', List: XcodeList, Get: XcodeGet, Delete: XcodeDelete },
  { kind: 'ios', List: IOSList, Get: IOSGet, Delete: IOSDelete },
])('$kind snapshot commands', ({ kind, List, Get, Delete }) => {
  const resource = { list: jest.fn(), get: jest.fn(), delete: jest.fn() };
  const setup = (Command: { prototype: object }, flags: Record<string, unknown> = {}) => {
    const command = Object.assign(Object.create(Command.prototype), {
      parse: async () => ({ args: { key: 'app-main' }, flags: { json: true, ...flags } }),
      setParsedFlags: jest.fn(),
      withAuth: async (run: () => Promise<void>) => run(),
      outputJson: jest.fn(),
      outputResult: jest.fn(),
      outputTable: jest.fn(),
      info: jest.fn(),
    });
    Object.defineProperty(command, 'client', { value: {} });
    jest.mocked(snapshotResource).mockReturnValue(resource as unknown as ReturnType<typeof snapshotResource>);
    return command;
  };
  beforeEach(() => jest.clearAllMocks());
  test('lists one page with a usable next offset in JSON', async () => {
    const page = { snapshots: [{ key: 'app-main', archiveSizeBytes: 42 }], nextOffset: 25 };
    resource.list.mockResolvedValue(page);
    const command = setup(List, { prefix: 'app-', limit: 25, offset: 0 });
    await command.run();
    expect(resource.list).toHaveBeenCalledWith({ prefix: 'app-', limit: 25, offset: 0 });
    expect(command.outputJson).toHaveBeenCalledWith(page);
  });
  test('gets from the explicitly selected organization', async () => {
    resource.get.mockResolvedValue({ key: 'app-main', saved: false });
    const command = setup(Get, { organization: 'org_other' });
    await command.run();
    expect(resource.get).toHaveBeenCalledWith('app-main');
    expect(snapshotResource).toHaveBeenCalledWith(expect.anything(), kind, 'org_other');
    expect(whoAmI).not.toHaveBeenCalled();
  });
  test('reports deletion only after the server succeeds and exposes flush', async () => {
    const command = setup(Delete);
    resource.delete.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(command.run()).rejects.toThrow('storage unavailable');
    expect(command.outputResult).not.toHaveBeenCalled();
    resource.delete.mockResolvedValueOnce(undefined);
    await command.run();
    expect(resource.delete).toHaveBeenLastCalledWith('app-main');
    expect(snapshotResource).toHaveBeenCalledWith(expect.anything(), kind, 'org_default');
    expect(command.outputResult).toHaveBeenCalledWith(
      { ok: true, key: 'app-main' },
      expect.stringContaining('Running instances'),
    );
    expect(Delete.aliases).toContain(`${kind}:snapshot:flush`);
  });
});
