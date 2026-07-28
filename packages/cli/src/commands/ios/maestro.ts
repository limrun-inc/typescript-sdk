import { spawn } from 'node:child_process';

import { Flags } from '@oclif/core';
import {
  MAESTRO_RUNNER_BUNDLE_ID,
  MAESTRO_RUNNER_PORT,
  isMaestroRunnerRunning,
  maestroSpawnOptions,
  prepareMaestroRun,
} from '@limrun/api';
import { BaseCommand } from '../../base-command';
import { getIosInstanceClient } from '../../lib/instance-client-factory';
import { INJECTED_MAESTRO_FLAGS, MAESTRO_RUNNER_ASSET_NAME } from '../../lib/maestro';

export default class IosMaestro extends BaseCommand {
  static summary = 'Run Maestro flows against a running iOS instance';
  static description =
    'Run the locally installed Maestro CLI against a remote Limrun iOS simulator. ' +
    'Ensures the Maestro XCTest runner is installed and running on the instance, then wires ' +
    'the local `maestro test` invocation to it transparently. Pass Maestro arguments after `--`. ' +
    `Creating the instance with \`--install-asset ${MAESTRO_RUNNER_ASSET_NAME}\` skips the install step here.`;
  static examples = [
    '<%= config.bin %> ios maestro test flow.yaml',
    '<%= config.bin %> ios maestro test flows/',
    '<%= config.bin %> ios maestro -- test flow.yaml --include-tags smoke --test-output-dir artifacts',
  ];

  static strict = false;

  static args = {};

  static flags = {
    ...BaseCommand.baseFlags,
    id: Flags.string({
      description: 'iOS instance ID to target. Defaults to the last created iOS instance.',
    }),
  };

  async run(): Promise<void> {
    const parsed = await this.parse(IosMaestro as any);
    const flags = parsed.flags as Record<string, any>;
    const rawArgs = (parsed.argv as string[]) ?? [];
    this.setParsedFlags(flags);

    await this.withAuth(async () => {
      if (rawArgs[0] !== 'test') {
        this.error(
          'Provide a maestro test invocation, for example `lim ios maestro test flow.yaml`. ' +
            'Only the `test` subcommand is supported.',
        );
      }
      const passthroughArgs = rawArgs.slice(1);
      for (const arg of passthroughArgs) {
        const flagName = arg.split('=')[0];
        if (flagName && INJECTED_MAESTRO_FLAGS.includes(flagName)) {
          this.error(`${flagName} is set by lim automatically, remove it from the maestro arguments.`);
        }
      }

      const resolvedInstance = this.resolveIosInstance(flags.id);
      const id = resolvedInstance.id;

      let { targetHttpPortUrlPrefix, token } = resolvedInstance;
      if (!targetHttpPortUrlPrefix || !token) {
        const instance = await this.client.iosInstances.get(id);
        targetHttpPortUrlPrefix = instance.status.targetHttpPortUrlPrefix;
        token = instance.status.token;
        // Forward the fresh endpoints so getIosInstanceClient connects directly
        // instead of fetching the instance a second time.
        resolvedInstance.apiUrl = instance.status.apiUrl;
        resolvedInstance.token = token;
      }
      if (!targetHttpPortUrlPrefix || !token) {
        this.error(`Instance ${id} does not expose the HTTP port URL required for Maestro.`);
      }
      const runnerUrl = targetHttpPortUrlPrefix + String(MAESTRO_RUNNER_PORT);

      // A responding runner proves it is installed, so the common path skips
      // the listApps round trip entirely.
      const [{ client, disconnect }, runnerRunning] = await Promise.all([
        getIosInstanceClient(this.client, resolvedInstance),
        isMaestroRunnerRunning(runnerUrl, token),
      ]);
      try {
        if (!runnerRunning) {
          const apps = await client.listApps();
          if (!apps.some((app) => app.bundleId === MAESTRO_RUNNER_BUNDLE_ID)) {
            this.info('Installing the Maestro runner on the instance...');
            const assets = await this.client.assets.list({
              nameFilter: MAESTRO_RUNNER_ASSET_NAME,
              includeAppStore: true,
              includeDownloadUrl: true,
            });
            const runnerAsset = assets.find((asset) => asset.name === MAESTRO_RUNNER_ASSET_NAME);
            if (!runnerAsset?.signedDownloadUrl) {
              this.error(`Maestro runner asset ${MAESTRO_RUNNER_ASSET_NAME} is not available.`);
            }
            await client.installApp(runnerAsset.signedDownloadUrl);
          }
          this.info('Launching the Maestro runner...');
          const launch = await client
            .simctl(['launch', '--terminate-running-process', 'booted', MAESTRO_RUNNER_BUNDLE_ID])
            .wait();
          if (launch.code !== 0) {
            this.error(`Failed to launch the Maestro runner (exit code ${launch.code}): ${launch.stderr}`);
          }
        }

        const run = await prepareMaestroRun(client, { runnerUrl });
        this.info(`Running maestro ${run.maestroVersion} against ${id}...`);
        const exitCode = await new Promise<number>((resolve, reject) => {
          const proc = spawn('maestro', ['test', ...run.args, ...passthroughArgs], {
            ...maestroSpawnOptions,
            env: { ...process.env, ...run.env },
            stdio: 'inherit',
          });
          proc.once('error', reject);
          // Maestro already reported to the inherited stdio; a signal death
          // simply becomes a nonzero exit.
          proc.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
        });
        if (exitCode !== 0) {
          this.exit(exitCode);
        }
      } finally {
        disconnect();
      }
    });
  }
}
