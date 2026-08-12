export interface LabelledInstance {
  metadata: {
    id: string;
  };
}

interface DeleteByLabelParams {
  labelSelector: string;
  state: string;
}

const ACTIVE_INSTANCE_STATES = 'creating,assigned,ready,unknown';

export async function deleteInstancesByLabels<T extends LabelledInstance>(
  labelSelector: string,
  list: (params: DeleteByLabelParams) => AsyncIterable<T>,
  deleteInstance: (id: string) => Promise<void>,
): Promise<string[]> {
  if (labelSelector.trim() === '') {
    throw new Error('Label selector must not be empty.');
  }

  const deletedIds: string[] = [];
  for await (const instance of list({
    labelSelector,
    state: ACTIVE_INSTANCE_STATES,
  })) {
    await deleteInstance(instance.metadata.id);
    deletedIds.push(instance.metadata.id);
  }
  return deletedIds;
}
