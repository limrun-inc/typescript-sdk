/**
 * The token of an instance record, for connecting to its data-plane endpoints.
 * A record comes back without one when the credential that read it may see the
 * instance but not control it (a read-only API key or a viewer seat); say so
 * rather than connecting with an empty token and failing later with a 403.
 */
export function instanceToken(instance: { metadata: { id: string }; status: { token?: string } }): string {
  const token = instance.status.token;
  if (!token) {
    throw new Error(
      `Instance ${instance.metadata.id} came back without its token: the credential used can read it but not control it.`,
    );
  }
  return token;
}
