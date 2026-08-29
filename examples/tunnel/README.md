# Network session capture

This example starts an Android destination tunnel, follows its inspection SSE
stream, assembles body chunks into browser-compatible HAR entries, and asks the
instance to persist the completed network log for 72 hours.

Set `LIM_API_KEY`, install dependencies, and run:

```sh
yarn start
```

`inspection.persist` requires inspection. It also captures request and response
bodies. `ttlSeconds` defaults to 72 hours and may not exceed 30 days. Local HAR
recording is independent of persistence; the `lim android tunnel` CLI exposes
it with `--har`, while `--persist [--ttl <seconds>]` controls the session
artifact.

Persisted captures can be listed later (even after instance termination):

```ts
const logs = await limrun.androidInstances.listSessionArtifacts(instanceId, 'networkLog');
console.log(logs[0]?.downloadUrl);
```

Browser applications can connect with native `EventSource` by using
`deriveDestinationTunnelInspectionURL(tunnelUrl, tunnelId, token)` and decode each message with
`decodeDestinationTunnelInspectionSSEEvent(message.lastEventId, message.data)`.
The token is placed in the query because native EventSource cannot set an
Authorization header.
