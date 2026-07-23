import express, { Request, Response } from 'express';
import cors from 'cors';
import Limrun from '@limrun/api';
import localtunnel from 'localtunnel';
import { deleteSecret, getSecret, listSecrets, putSecret } from './secret-store.js';
import { getPublishStatus, receivePublishWebhook, startPublish, type PublishRequest } from './publish.js';

// Used to mint scoped registry tokens and by the lim CLI spawned for
// publishes.
const apiKey = process.env['LIM_API_KEY'];
if (!apiKey) {
  console.error('Error: Missing required environment variable (LIM_API_KEY).');
  process.exit(1);
}

const registryUrl = process.env['LIM_REGISTRY_ENDPOINT'] ?? 'https://registry.limrun.com';

const limrun = new Limrun({ apiKey });

const app = express();
const port = 3000;
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// The public HTTPS front for the webhook receiver, assigned once the tunnel
// (or PUBLIC_URL) is resolved at the bottom of this file.
let publicUrl: string | undefined;

// The Connect phase's Apple relay session: mints a short-lived scoped token
// so the browser can speak the Apple relay protocol against Limrun's
// registry directly. The API key never leaves this backend; the token can
// only open the Apple relay, and it expires on its own. The relay is not
// tied to any instance, so no Xcode instance exists until a publish
// actually spawns `lim xcode build`.
app.post('/session', async (_req: Request, res: Response) => {
  try {
    const session = await limrun.scopedTokens.create({ scopes: ['applerelay:*:connect'] });
    return res.status(200).json({ token: session.token, expiresAt: session.expiresAt, registryUrl });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

// The file-based secret store, exposed with the same response shape as
// Limrun's organization secrets API so the frontend's SigningSecretStore
// implementation is a thin fetch wrapper. Secret names contain slashes
// (e.g. TEAMID/DISTRIBUTION), so clients URI-encode the name segment.

// Metadata only — secret data never appears in listings.
app.get('/secrets', async (_req: Request, res: Response) => {
  try {
    const secrets = await listSecrets();
    return res.status(200).json(secrets.map(({ type, name, createdAt }) => ({ type, name, createdAt })));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

app.get('/secrets/:type/:name', async (req: Request<{ type: string; name: string }>, res: Response) => {
  try {
    const secret = await getSecret(req.params.type, req.params.name);
    if (!secret) {
      return res.status(404).json({ status: 'error', message: 'Secret not found' });
    }
    return res.status(200).json(secret);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

app.put(
  '/secrets/:type/:name',
  async (
    req: Request<{ type: string; name: string }, {}, { data?: Record<string, string> }>,
    res: Response,
  ) => {
    try {
      const { data } = req.body;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ status: 'error', message: 'Body must contain a data object' });
      }
      const secret = await putSecret(req.params.type, req.params.name, data);
      return res.status(200).json(secret);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      return res.status(500).json({ status: 'error', message });
    }
  },
);

app.delete('/secrets/:type/:name', async (req: Request<{ type: string; name: string }>, res: Response) => {
  try {
    await deleteSecret(req.params.type, req.params.name);
    return res.status(200).json({ status: 'success' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

// Starts `lim xcode build --upload-to-testflight` with the stored signing
// material and a build-finish webhook pointing back at this backend through
// the public tunnel URL. The CLI provisions (or reuses) its own Xcode
// instance — the only point in the whole flow where one exists. Responds
// immediately with the publish ID; the frontend polls GET /publish/:id
// until the webhook settles it.
app.post('/publish', async (req: Request<{}, {}, Partial<PublishRequest>>, res: Response) => {
  const { projectPath, method, teamId, bundleId, scheme } = req.body;
  if (!projectPath || !teamId || !bundleId || (method !== 'testflight' && method !== 'appstore')) {
    return res.status(400).json({
      status: 'error',
      message: 'projectPath, teamId, bundleId and method (testflight | appstore) are required',
    });
  }
  if (!publicUrl) {
    return res.status(503).json({
      status: 'error',
      message: 'The webhook tunnel is still starting; try again in a few seconds.',
    });
  }
  try {
    const id = await startPublish({ projectPath, method, teamId, bundleId, scheme }, publicUrl);
    return res.status(202).json({ publishId: id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

// Polled by the frontend while it shows "Waiting for build callback".
app.get('/publish/:id', (req: Request<{ id: string }>, res: Response) => {
  const status = getPublishStatus(req.params.id);
  if (!status) {
    return res.status(404).json({ status: 'error', message: 'Publish not found' });
  }
  return res.status(200).json(status);
});

// The webhook receiver is its own Express app on its own port: the tunnel
// makes whatever it fronts reachable by anyone on the internet, and the main
// app serves the secret store. Only this app — one token-guarded POST route —
// goes public.
const hooks = express();
const webhookPort = 3001;
hooks.use(express.json({ limit: '1mb' }));

// The build-finish webhook limbuild POSTs to (through the tunnel) once the
// build reaches a terminal state. Authenticated with the per-publish token
// the CLI was given via --webhook-header.
hooks.post('/webhook/:id', (req: Request<{ id: string }>, res: Response) => {
  const token = req.header('X-Publish-Token');
  if (!receivePublishWebhook(req.params.id, token, req.body)) {
    // 404 for both unknown IDs and bad tokens: no oracle for URL guessers.
    return res.status(404).json({ status: 'error', message: 'Publish not found' });
  }
  console.log(`[publish ${req.params.id}] webhook received:`, JSON.stringify(req.body));
  return res.status(204).end();
});

// The webhook receiver must be reachable from limbuild, which runs inside
// Limrun's cloud (and rejects private or IP-literal callback URLs). By
// default the backend opens a localtunnel — no account or token needed, and
// loca.lt hostnames ride an existing wildcard DNS record, so the URL works
// the moment it is issued (unlike trycloudflare hostnames, whose DNS can
// take minutes to propagate). Or bring your own public URL with PUBLIC_URL,
// forwarded to the webhook receiver's port.
async function resolvePublicUrl(): Promise<string> {
  const configured = process.env['PUBLIC_URL'];
  if (configured) return configured.replace(/\/$/, '');
  console.log('Opening a localtunnel for the webhook receiver...');
  const tunnel = await localtunnel({ port: webhookPort });
  tunnel.on('error', (error: Error) => {
    console.error(`localtunnel error: ${error.message}; build webhooks may not arrive.`);
  });
  tunnel.on('close', () => {
    console.error('localtunnel closed; build webhooks can no longer arrive.');
  });
  return tunnel.url;
}

hooks.listen(webhookPort, () => {
  console.log(`Webhook receiver listening at http://localhost:${webhookPort}`);
});
app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});

// The tunnel comes up after the servers; POST /publish returns 503 until
// this resolves.
publicUrl = await resolvePublicUrl();
console.log(`Build webhooks arrive via ${publicUrl}/webhook/:id`);
