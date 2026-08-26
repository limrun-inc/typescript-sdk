import { type InstanceClient, Ios } from '@limrun/api';
import { runElementTreeDaemonCommand } from './daemon';

describe('element-tree daemon dispatch', () => {
  it('passes Android element-tree options to the SDK client', async () => {
    const getElementTree = jest.fn().mockResolvedValue({ xml: '<hierarchy />', nodes: [] });
    const client = { getElementTree } as unknown as InstanceClient;
    const options = { waitForIdleTimeoutMs: 12_345 };

    await expect(runElementTreeDaemonCommand('android', client, [options])).resolves.toEqual({
      xml: '<hierarchy />',
      nodes: [],
    });
    expect(getElementTree).toHaveBeenCalledWith(options);
  });

  it('passes undefined for an Android request without CLI options', async () => {
    const getElementTree = jest.fn().mockResolvedValue({ xml: '', nodes: [] });
    const client = { getElementTree } as unknown as InstanceClient;

    await runElementTreeDaemonCommand('android', client, []);

    expect(getElementTree).toHaveBeenCalledWith(undefined);
  });

  it('leaves iOS element-tree calls unchanged', async () => {
    const elementTree = jest.fn().mockResolvedValue([{ type: 'Application' }]);
    const client = { elementTree } as unknown as Ios.InstanceClient;

    await runElementTreeDaemonCommand('ios', client, [{ waitForIdleTimeoutMs: 1000 }]);

    expect(elementTree).toHaveBeenCalledWith();
  });
});
