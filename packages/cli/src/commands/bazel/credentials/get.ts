import { Command } from '@oclif/core';
import Limrun, { APIError } from '@limrun/api';
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
    try {
      process.stdout.write(JSON.stringify(await bazelCredentials(client)));
    } catch (err) {
      // Bazel shows this text in its own output, so name the fix.
      if (err instanceof APIError && err.status === 401) {
        this.error('Limrun rejected the stored credential: run `lim login`, or set a valid LIM_API_KEY.');
      }
      if (err instanceof APIError && err.status === 403) {
        this.error(
          "This credential cannot build on Limrun's build plane: use a member's key or `lim login`.",
        );
      }
      throw err;
    }
  }
}
