import type { GradleClient } from '@limrun/api/resources/gradle-instances-helpers';
import type { ExecChildProcess } from '@limrun/api/exec-client';
import { formatDurationMs } from './duration';
import { formatBytes } from './bytes';

type BuildClient = Pick<GradleClient, 'sync' | 'run'>;
type ReportError = (message: string, options: { exit: number }) => never;

export async function syncBuildProject(
  client: BuildClient,
  options: Parameters<BuildClient['sync']>[1],
  info: (message: string) => void,
): Promise<void> {
  const directory = process.cwd();
  info(`Syncing ${directory}...`);
  const started = Date.now();
  const result = await client.sync(directory, options);
  const size = result.bytesSent === undefined ? '' : ` (${formatBytes(result.bytesSent)} sent)`;
  info(`Sync completed in ${formatDurationMs(Date.now() - started)}${size}.`);
}

export async function streamBuildCommand(
  proc: ExecChildProcess,
  error: ReportError,
  failure = 'Command failed',
): Promise<void> {
  proc.stdout.on('data', (line: string) => process.stdout.write(line + '\n'));
  proc.stderr.on('data', (line: string) => process.stderr.write(line + '\n'));
  const result = await proc;
  if (result.exitCode === 0) return;
  if (result.timedOut) {
    error(
      result.incomplete && result.incomplete.reason !== 'timeout' ?
        `${result.incomplete.message}.`
      : 'Timed out waiting for the command to finish; the remote command may still be running.',
      { exit: result.exitCode },
    );
  }
  error(`${failure} with exit code ${result.exitCode}.`, { exit: result.exitCode });
}
