/**
 * parsePortMapping reads a forward's `<port>` or `<localPort>:<remotePort>`. Local port 0 asks the
 * system for a free port; the remote port must name a real one.
 */
export function parsePortMapping(mapping: string): { localPort: number; remotePort: number } {
  if (!/^\d+(?::\d+)?$/.test(mapping)) {
    throw new Error('Mapping must be <port> or <localPort>:<remotePort>.');
  }
  const [local, remote = local] = mapping.split(':');
  const localPort = Number(local);
  const remotePort = Number(remote);
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    throw new Error('localPort must be between 0 and 65535.');
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error('remotePort must be between 1 and 65535.');
  }
  return { localPort, remotePort };
}
