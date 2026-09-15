import type { ExecLogOptions, ExecLogResult } from '@limrun/api/exec-client';
import type { BuildLog } from '@limrun/api/resources/daemon-client-shared';

export type BuildLogsResult = {
  instanceId: string;
  execId: string;
  status: string;
  exitCode?: number;
  logs: string;
  source: 'retained' | 'persisted';
};

type BuildLogsOptions = {
  instanceId: string;
  execId?: string;
  follow: boolean;
  listPersisted: () => Promise<BuildLog[]>;
  observe: (
    execId: string,
    options: Required<Pick<ExecLogOptions, 'follow' | 'onEvent'>>,
  ) => Promise<ExecLogResult>;
  fetchText?: (url: string) => Promise<string>;
  onText?: (text: string, stream: 'stdout' | 'stderr') => void;
};

/**
 * Returns logs for a specific build or the latest build, including one still running.
 * Retained SSE is preferred for the latest build; durable object storage is
 * preferred for a specific build once its metadata sidecar exists.
 */
export async function getBuildLogs(options: BuildLogsOptions): Promise<BuildLogsResult> {
  if (options.execId) {
    if (!isBuildExecId(options.execId)) {
      throw new Error(`Invalid build exec ID ${options.execId}; expected build-<number>.`);
    }
    const persisted = await tryListPersisted(options.listPersisted);
    const record = persisted.records.find((entry) => entry.id === options.execId);
    if (record) {
      return readPersisted(options, record);
    }

    try {
      return await readRetained(options, options.execId);
    } catch (retainedError) {
      if (!isRetainedBuildNotFound(retainedError)) {
        throw retainedError;
      }
      // Persistence commits just after the terminal event. Refresh once to
      // close that race before reporting a missing/pruned exec.
      const refreshed = await tryListPersisted(options.listPersisted);
      const refreshedRecord = refreshed.records.find((entry) => entry.id === options.execId);
      if (refreshedRecord) {
        return readPersisted(options, refreshedRecord);
      }
      if (refreshed.error) {
        throw refreshed.error;
      }
      if (!isMissingBuild(retainedError)) throw retainedError;
      throw new Error(`Build ${options.execId} was not found on instance ${options.instanceId}.`);
    }
  }

  try {
    return await readRetained(options, 'latest');
  } catch (latestError) {
    if (!isRetainedBuildNotFound(latestError)) {
      throw latestError;
    }
    const persisted = await tryListPersisted(options.listPersisted);
    const latest = persisted.records[persisted.records.length - 1];
    if (latest) {
      return readPersisted(options, latest);
    }
    if (persisted.error) {
      throw persisted.error;
    }
    if (!isMissingBuild(latestError)) throw latestError;
    throw new Error(`No active or persisted builds found for instance ${options.instanceId}.`);
  }
}

async function readRetained(options: BuildLogsOptions, execId: string): Promise<BuildLogsResult> {
  const parts: string[] = [];
  const observed = await options.observe(execId, {
    follow: options.follow,
    onEvent: (event) => {
      let text: string | undefined;
      let stream: 'stdout' | 'stderr' = 'stdout';
      if (event.type === 'command') {
        text = `$ ${event.data}`;
      } else if (event.type === 'stdout') {
        text = event.data;
      } else if (event.type === 'stderr') {
        text = event.data;
        stream = 'stderr';
      }
      if (text === undefined) return;
      const chunk = text.endsWith('\n') ? text : `${text}\n`;
      parts.push(chunk);
      options.onText?.(chunk, stream);
    },
  });
  return {
    instanceId: options.instanceId,
    execId: observed.execId,
    status: observed.status,
    ...(observed.exitCode !== undefined && { exitCode: observed.exitCode }),
    logs: parts.join(''),
    source: 'retained',
  };
}

async function readPersisted(options: BuildLogsOptions, record: BuildLog): Promise<BuildLogsResult> {
  const logs = await (options.fetchText ?? fetchBuildLog)(record.downloadUrl);
  options.onText?.(logs, 'stdout');
  return {
    instanceId: options.instanceId,
    execId: record.id,
    status: record.status,
    ...(record.exitCode !== undefined && { exitCode: record.exitCode }),
    logs,
    source: 'persisted',
  };
}

async function tryListPersisted(
  listPersisted: () => Promise<BuildLog[]>,
): Promise<{ records: BuildLog[]; error?: unknown }> {
  try {
    const records = (await listPersisted()).filter((record) => isBuildExecId(record.id));
    records.sort((a, b) => {
      const aId = BigInt(a.id.slice(6));
      const bId = BigInt(b.id.slice(6));
      return (
        aId < bId ? -1
        : aId > bId ? 1
        : 0
      );
    });
    return { records };
  } catch (error) {
    return { records: [], error };
  }
}

async function fetchBuildLog(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download build log: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function isRetainedBuildNotFound(err: unknown): err is Error {
  // A deleted instance can still have persisted build logs.
  return err instanceof Error && (err as Error & { status?: number }).status === 404;
}

function isMissingBuild(err: Error): boolean {
  return (
    err.message.includes('GET exec logs failed: 404') &&
    (err.message.includes('"message":"build not found"') ||
      err.message.includes('"message":"no builds exist"'))
  );
}

function isBuildExecId(execId: string): boolean {
  return /^build-[0-9]+$/.test(execId);
}
