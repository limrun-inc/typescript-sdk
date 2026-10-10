import type { TunnelConnectorEvent } from '@limrun/api';

/**
 * One human-readable log line per connector event. name is undefined until
 * the first active, for a connector started with a tunnel token alone.
 */
export function formatTunnelConnectorEvent(
  name: string | undefined,
  event: TunnelConnectorEvent,
  ephemeral = false,
): string {
  const tunnel = name ? `tunnel ${name}` : 'the tunnel';
  switch (event.type) {
    case 'active':
      return (
        `Tunnel ${event.name} is active. Instances created with --tunnel ${event.name} attach here; ` +
        `press Ctrl+C to stop.` +
        (ephemeral ? ' It is a quick tunnel and goes away when this connector exits.' : '')
      );
    case 'tokenExpiring':
      // A quick tunnel's token goes with it, so a restart brings a new one.
      return ephemeral ?
          `The token of quick ${tunnel} expires at ${event.expiresAt}. Restart the connector to get a new one.`
        : `The token this connector runs with expires at ${event.expiresAt}. Issue a new one with ` +
            `lim tunnel rotate ${name ?? '<name>'} and restart the connector with it.`;
    case 'standby':
      return (
        `Standby: ${event.holder.hostname} holds ${tunnel}` +
        (event.holder.since ? ` since ${event.holder.since}. ` : '. ') +
        'Waiting for it to go away; use --replace to take it over.'
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

/**
 * The lines that hand over a tunnel token after `create` or `rotate`: the
 * connector command with the token, which Limrun shows only this once.
 */
export function formatIssuedToken(lead: string, token: { token: string; expiresAt: string }): string {
  return [
    lead,
    '',
    `  lim tunnel run --token ${token.token}`,
    '',
    `The token runs this tunnel alone and is shown only once. It expires at ${token.expiresAt}.`,
  ].join('\n');
}
