import type { WebhookConfig } from '@limrun/api';

export interface WebhookFlagValues {
  'webhook-url'?: string;
  'webhook-header'?: string[];
  'webhook-label'?: string[];
}

/**
 * Server-side cap on webhook labels, enforced here too so a doomed build never
 * reaches a billed instance. Per-label shape (64 printable ASCII characters
 * per key and value) is left to the daemon.
 */
export const MAX_WEBHOOK_LABELS = 32;

/**
 * Maps the shared --webhook-url / --webhook-header / --webhook-label flags
 * onto the exec request's webhook config, throwing on invalid combinations.
 * Pure and oclif-free so both `xcode build` and `gradle build` share it and
 * it is unit-testable.
 *
 * Duplicate header names are rejected (case-insensitively: header names are
 * case-insensitive on the wire, and the daemon canonicalizes them) instead
 * of last-one-wins, so a misconfigured CI auth header fails at the command
 * line rather than silently at callback time. Label keys are echoed verbatim
 * as JSON object keys, so their duplicate check is exact.
 */
export function webhookConfigFromFlags(flags: WebhookFlagValues): WebhookConfig | undefined {
  const headerEntries = flags['webhook-header'] ?? [];
  const labelEntries = flags['webhook-label'] ?? [];
  if (!flags['webhook-url']) {
    if (headerEntries.length > 0) {
      throw new Error('--webhook-header requires --webhook-url.');
    }
    if (labelEntries.length > 0) {
      throw new Error('--webhook-label requires --webhook-url.');
    }
    return undefined;
  }
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [index, entry] of headerEntries.entries()) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      // Reported by position, never echoed: the entry is usually an
      // Authorization value, and one that came from the environment is
      // otherwise absent from the terminal.
      throw new Error(`Invalid --webhook-header entry ${index + 1}: expected NAME=VALUE.`);
    }
    const name = entry.slice(0, separator);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate --webhook-header name ${JSON.stringify(name)}.`);
    }
    seen.add(key);
    headers[name] = entry.slice(separator + 1);
  }
  const labelPairs: Array<[string, string]> = [];
  const seenLabels = new Set<string>();
  for (const [index, entry] of labelEntries.entries()) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid --webhook-label entry ${index + 1}: expected KEY=VALUE.`);
    }
    const key = entry.slice(0, separator);
    if (seenLabels.has(key)) {
      throw new Error(`Duplicate --webhook-label key ${JSON.stringify(key)}.`);
    }
    seenLabels.add(key);
    labelPairs.push([key, entry.slice(separator + 1)]);
  }
  if (labelPairs.length > MAX_WEBHOOK_LABELS) {
    throw new Error(`--webhook-label accepts at most ${MAX_WEBHOOK_LABELS} labels.`);
  }
  return {
    url: flags['webhook-url'],
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(labelPairs.length > 0 && { labels: Object.fromEntries(labelPairs) }),
  };
}
