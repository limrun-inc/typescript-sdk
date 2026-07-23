import type { WebhookConfig } from '@limrun/api';

export interface WebhookFlagValues {
  'webhook-url'?: string;
  'webhook-header'?: string[];
}

/**
 * Maps the shared --webhook-url / --webhook-header flags onto the exec
 * request's webhook config, throwing on invalid combinations. Pure and
 * oclif-free so both `xcode build` and `gradle build` share it and it is
 * unit-testable.
 *
 * Duplicate header names are rejected (case-insensitively: header names are
 * case-insensitive on the wire, and the daemon canonicalizes them) instead
 * of last-one-wins, so a misconfigured CI auth header fails at the command
 * line rather than silently at callback time.
 */
export function webhookConfigFromFlags(flags: WebhookFlagValues): WebhookConfig | undefined {
  const headerEntries = flags['webhook-header'] ?? [];
  if (!flags['webhook-url']) {
    if (headerEntries.length > 0) {
      throw new Error('--webhook-header requires --webhook-url.');
    }
    return undefined;
  }
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const entry of headerEntries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid --webhook-header ${JSON.stringify(entry)}: expected NAME=VALUE.`);
    }
    const name = entry.slice(0, separator);
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate --webhook-header name ${JSON.stringify(name)}.`);
    }
    seen.add(key);
    headers[name] = entry.slice(separator + 1);
  }
  return {
    url: flags['webhook-url'],
    ...(Object.keys(headers).length > 0 && { headers }),
  };
}
