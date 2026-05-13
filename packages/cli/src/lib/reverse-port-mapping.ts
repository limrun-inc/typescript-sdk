import { Ios } from '@limrun/api';

export type ReversePortMapping = {
  remotePort: number;
  localPort: number;
};

function parsePort(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a number`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < min || port > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return port;
}

export function parseReversePortMapping(mapping: string): ReversePortMapping {
  const parts = mapping.split(':');
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new Error('Mapping must be <remotePort> or <remotePort>:<localPort>');
  }

  const remotePort = parsePort(
    parts[0]!,
    'remotePort',
    Ios.REVERSE_TUNNEL_REMOTE_PORT_MIN,
    Ios.REVERSE_TUNNEL_REMOTE_PORT_MAX,
  );
  const localPort = parts[1] ? parsePort(parts[1], 'localPort', 1, 65535) : remotePort;

  return { remotePort, localPort };
}
