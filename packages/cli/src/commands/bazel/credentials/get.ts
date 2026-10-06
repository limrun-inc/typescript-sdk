import { Command } from '@oclif/core';
import Limrun from '@limrun/api';
import { bazelCredentials } from '../../../lib/bazel-setup';
import { readConfig } from '../../../lib/config';
import { readStdin } from '../../../lib/stdin';

/**
 * Bazel's credential helper for the build plane. Bazel runs it as
 * `lim-bazel-credentials get` with the request URI on stdin, and reads the
 * headers to send from stdout, so stdout carries that JSON and nothing else.
 * It mints a short-lived scoped token from `lim login` or LIM_API_KEY.
 */
export default class BazelCredentialsGet extends Command {
  static hidden = true;
  static summary = "Print Bazel's build plane credentials (Bazel credential helper protocol)";

  async run(): Promise<void> {
    // Bazel sends {"uri": ...}; every plane URI takes the same credentials.
    await readStdin();
    const config = readConfig();
    if (!config.apiKey) {
      this.error('Not authenticated: run `lim login`, or set LIM_API_KEY in CI.');
    }
    const client = new Limrun({ apiKey: config.apiKey, baseURL: config.apiEndpoint });
    process.stdout.write(JSON.stringify(await bazelCredentials(client)));
  }
}
