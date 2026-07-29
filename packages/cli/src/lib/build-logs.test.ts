import { getBuildLogs, type PersistedBuildLog } from './build-logs';

describe('getBuildLogs', () => {
  test('returns an active build snapshot', async () => {
    const onText = jest.fn();
    const listPersisted = jest.fn(async (): Promise<PersistedBuildLog[]> => []);

    await expect(
      getBuildLogs({
        instanceId: 'xcode_test',
        follow: false,
        listPersisted,
        observe: async (execId, options) => {
          options.onEvent({ type: 'command', data: 'xcodebuild -scheme App' });
          options.onEvent({ type: 'stdout', data: 'Compiling' });
          return { execId, status: 'RUNNING' };
        },
        onText,
      }),
    ).resolves.toEqual({
      instanceId: 'xcode_test',
      execId: 'active',
      status: 'RUNNING',
      logs: '$ xcodebuild -scheme App\nCompiling\n',
      source: 'retained',
    });
    expect(listPersisted).not.toHaveBeenCalled();
    expect(onText).toHaveBeenCalledTimes(2);
  });

  test('falls back from no active build to the latest persisted build', async () => {
    const records: PersistedBuildLog[] = [
      { id: 'build-1', status: 'FAILED', exitCode: 1, downloadUrl: 'https://logs/1' },
      { id: 'build-2', status: 'SUCCEEDED', exitCode: 0, downloadUrl: 'https://logs/2' },
      { id: 'run-3', status: 'SUCCEEDED', exitCode: 0, downloadUrl: 'https://logs/run' },
    ];

    await expect(
      getBuildLogs({
        instanceId: 'gradle_test',
        follow: false,
        listPersisted: async () => records,
        observe: async () => {
          throw notFound();
        },
        fetchText: async (url) => `downloaded ${url}\n`,
      }),
    ).resolves.toEqual({
      instanceId: 'gradle_test',
      execId: 'build-2',
      status: 'SUCCEEDED',
      exitCode: 0,
      logs: 'downloaded https://logs/2\n',
      source: 'persisted',
    });
  });

  test('prefers durable logs for a specific completed build', async () => {
    const observe = jest.fn();
    const record = {
      id: 'build-1',
      status: 'CANCELLED',
      exitCode: -1,
      downloadUrl: 'https://logs/1',
    };

    const result = await getBuildLogs({
      instanceId: 'xcode_test',
      execId: 'build-1',
      follow: true,
      listPersisted: async () => [record],
      observe,
      fetchText: async () => 'cancelled\n',
    });

    expect(result.source).toBe('persisted');
    expect(result.status).toBe('CANCELLED');
    expect(observe).not.toHaveBeenCalled();
  });

  test('refreshes persisted logs after a terminal retention race', async () => {
    const record = {
      id: 'build-1',
      status: 'SUCCEEDED',
      exitCode: 0,
      downloadUrl: 'https://logs/1',
    };
    const listPersisted = jest
      .fn<Promise<PersistedBuildLog[]>, []>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([record]);

    const result = await getBuildLogs({
      instanceId: 'xcode_test',
      execId: 'build-1',
      follow: false,
      listPersisted,
      observe: async () => {
        throw notFound();
      },
      fetchText: async () => 'finished\n',
    });

    expect(result.source).toBe('persisted');
    expect(listPersisted).toHaveBeenCalledTimes(2);
  });

  test('uses the latest retained build during the durable upload gap', async () => {
    const listPersisted = jest.fn(async (): Promise<PersistedBuildLog[]> => []);

    const result = await getBuildLogs({
      instanceId: 'xcode_test',
      follow: false,
      listPersisted,
      observe: async (execId) => {
        if (execId === 'active') throw notFound();
        return { execId: 'build-9', status: 'SUCCEEDED', exitCode: 0 };
      },
    });

    expect(result).toMatchObject({ execId: 'build-9', status: 'SUCCEEDED', source: 'retained' });
    expect(listPersisted).not.toHaveBeenCalled();
  });

  test('does not mask active stream failures with stale logs', async () => {
    const stale = { id: 'build-1', status: 'SUCCEEDED', downloadUrl: 'https://logs/1' };
    const unavailable = Object.assign(new Error('daemon unavailable'), { status: 503 });
    const listPersisted = jest.fn(async () => [stale]);

    await expect(
      getBuildLogs({
        instanceId: 'xcode_test',
        follow: false,
        listPersisted,
        observe: async () => {
          throw unavailable;
        },
      }),
    ).rejects.toBe(unavailable);
    expect(listPersisted).not.toHaveBeenCalled();
  });

  test('reports a missing exec without an instance-level 404', async () => {
    const error = await getBuildLogs({
      instanceId: 'xcode_test',
      execId: 'build-404',
      follow: false,
      listPersisted: async () => [],
      observe: async () => {
        throw notFound();
      },
    }).catch((err: unknown) => err);

    expect(error).toEqual(new Error('Build build-404 was not found on instance xcode_test.'));
    expect((error as { status?: number }).status).toBeUndefined();
  });

  test('preserves an instance-level 404 for BaseCommand handling', async () => {
    const instanceMissing = Object.assign(
      new Error('404 GET exec logs failed: 404 {"message":"instance not found"}'),
      { status: 404 },
    );

    await expect(
      getBuildLogs({
        instanceId: 'xcode_missing',
        execId: 'build-1',
        follow: false,
        listPersisted: async () => [],
        observe: async () => {
          throw instanceMissing;
        },
      }),
    ).rejects.toBe(instanceMissing);
  });

  test('reports when an instance has no builds', async () => {
    await expect(
      getBuildLogs({
        instanceId: 'xcode_empty',
        follow: false,
        listPersisted: async () => [],
        observe: async () => {
          throw notFound();
        },
      }),
    ).rejects.toThrow('No active or persisted builds found for instance xcode_empty.');
  });
});

function notFound(): Error {
  return Object.assign(new Error('404 GET exec logs failed: 404 {"message":"build not found"}'), {
    status: 404,
  });
}
