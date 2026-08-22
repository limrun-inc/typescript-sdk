import { deleteInstancesByLabels, type LabelledInstance } from '../packages/cli/src/lib/delete-instances';

async function* instances(ids: string[]): AsyncGenerator<LabelledInstance> {
  for (const id of ids) {
    yield { metadata: { id } };
  }
}

test('deletes every active instance returned across label-filtered pages', async () => {
  const list = jest.fn(() => instances(['ios_one', 'ios_two', 'ios_three']));
  const deleteInstance = jest.fn(async () => {});

  await expect(deleteInstancesByLabels('env=ci,team=mobile', list, deleteInstance)).resolves.toEqual([
    'ios_one',
    'ios_two',
    'ios_three',
  ]);
  expect(list).toHaveBeenCalledWith({
    labelSelector: 'env=ci,team=mobile',
    state: 'creating,assigned,ready,unknown',
  });
  expect(deleteInstance.mock.calls).toEqual([['ios_one'], ['ios_two'], ['ios_three']]);
});

test('does not issue delete requests when no active instances match', async () => {
  const deleteInstance = jest.fn(async () => {});

  await expect(deleteInstancesByLabels('env=missing', () => instances([]), deleteInstance)).resolves.toEqual(
    [],
  );
  expect(deleteInstance).not.toHaveBeenCalled();
});

test('rejects an empty selector instead of deleting every active instance', async () => {
  const list = jest.fn(() => instances(['ios_one']));
  const deleteInstance = jest.fn(async () => {});

  await expect(deleteInstancesByLabels('  ', list, deleteInstance)).rejects.toThrow(
    'Label selector must not be empty.',
  );
  expect(list).not.toHaveBeenCalled();
  expect(deleteInstance).not.toHaveBeenCalled();
});
