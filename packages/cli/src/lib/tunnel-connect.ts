import type { TunnelConnectorEvent } from '@limrun/api';

/** One lowercase DNS label, the rule the API enforces for tunnel names. */
const TUNNEL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function parseTunnelName(name: string): string {
  if (name.length > 63 || !TUNNEL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid tunnel name "${name}": use 1 to 63 lowercase letters, digits, and hyphens, ` +
        'starting and ending with a letter or digit.',
    );
  }
  return name;
}

/** One human-readable log line per connector event. */
export function formatTunnelConnectorEvent(name: string, event: TunnelConnectorEvent): string {
  switch (event.type) {
    case 'active':
      return `Tunnel ${name} is active. Instances created with --tunnel ${name} attach here; press Ctrl+C to stop.`;
    case 'standby':
      return (
        `Standby: ${event.holder.hostname} holds tunnel ${name}` +
        (event.holder.since ? ` since ${event.holder.since}. ` : '. ') +
        'Waiting for it to go away; use --replace to take the name over.'
      );
    case 'attached':
      return `Attached ${event.instanceId} (tunnel ${event.tunnelId}).`;
    case 'detached':
      return `Detached ${event.instanceId}: ${event.reason}.`;
    case 'notice':
      return `Notice${event.instanceId ? ` for ${event.instanceId}` : ''}: ${event.message} (${event.code}).`;
    case 'attachFailed':
      return `Could not attach ${event.instanceId}: ${event.message} (${event.code}).`;
    case 'reconnecting': {
      const delay = `${(event.delayMs / 1000).toFixed(1)}s`;
      return event.instanceId ?
          `Retrying ${event.instanceId} in ${delay}: ${event.reason}.`
        : `Reconnecting to Limrun in ${delay}: ${event.reason}. Attached instances keep their tunnels.`;
    }
  }
}
