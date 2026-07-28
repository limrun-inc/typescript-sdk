import express, { Request, Response } from 'express';
import cors from 'cors';
import Limrun from '@limrun/api';
import { defaultSecretsDir, deleteSecret, getSecret, listSecrets, putSecret } from './secret-store.js';
import { getPublishStatus, receivePublishWebhook, startPublish, type PublishRequest } from './publish.js';
import { detectAndroidPackage, startAndroidPublish, type AndroidPublishRequest } from './publish-android.js';

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

// The Connect phase's Apple relay session: mints a short-lived scoped token
// so the browser can speak the Apple relay protocol against Limrun's
// registry directly. The API key never leaves this backend; the token can
// only open the Apple relay, and it expires on its own. The relay is not
// tied to any instance, so no Xcode instance exists until a publish
// actually spawns `lim xcode build`.
app.post('/session', async (_req: Request, res: Response) => {
  try {
    const session = await limrun.scopedTokens.create({ scopes: ['applerelay:*:connect'] });
    return res.status(200).json({
      token: session.token,
      expiresAt: session.expiresAt,
      registryUrl,
      // The store directory used when requests don't name one; the UI
      // shows it as the default of its secrets-directory field.
      secretsDir: defaultSecretsDir(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

// The file-based secret store, exposed with the same response shape as
// Limrun's organization secrets API so the frontend's SigningSecretStore
// implementation is a thin fetch wrapper. Secret names contain slashes
// (e.g. TEAMID/DISTRIBUTION), so clients URI-encode the name segment.
// The optional `dir` query parameter selects the store directory; absent
// or empty means the backend default.

/** The store directory a request asked for, when it named one. */
function secretsDirOf(req: Request): string | undefined {
  const dir = req.query['dir'];
  return typeof dir === 'string' && dir.trim() ? dir : undefined;
}

// Metadata only — secret data never appears in listings.
app.get('/secrets', async (req: Request, res: Response) => {
  try {
    const secrets = await listSecrets(secretsDirOf(req));
    return res.status(200).json(secrets.map(({ type, name, createdAt }) => ({ type, name, createdAt })));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

app.get('/secrets/:type/:name', async (req: Request<{ type: string; name: string }>, res: Response) => {
  try {
    const secret = await getSecret(req.params.type, req.params.name, secretsDirOf(req));
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
      const secret = await putSecret(req.params.type, req.params.name, data, secretsDirOf(req));
      return res.status(200).json(secret);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      return res.status(500).json({ status: 'error', message });
    }
  },
);

app.delete('/secrets/:type/:name', async (req: Request<{ type: string; name: string }>, res: Response) => {
  try {
    await deleteSecret(req.params.type, req.params.name, secretsDirOf(req));
    return res.status(200).json({ status: 'success' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

// Starts a detached `lim xcode build` with the stored signing material and a
// build-finish webhook, uploading the result to App Store Connect. The
// webhook URL comes from the UI with each request: limbuild runs inside
// Limrun's cloud and rejects private or IP-literal callback URLs, so it
// must be a public URL that forwards to the webhook receiver's port 3001
// (e.g. from `ngrok http 3001`).
app.post('/publish', async (req: Request<{}, {}, Partial<PublishRequest>>, res: Response) => {
  const { projectPath, teamId, bundleId, scheme, secretsDir, webhookUrl } = req.body;
  if (!projectPath || !teamId || !bundleId || !webhookUrl) {
    return res.status(400).json({
      status: 'error',
      message: 'projectPath, teamId, bundleId and webhookUrl are required',
    });
  }
  try {
    const id = await startPublish({ projectPath, teamId, bundleId, scheme, secretsDir, webhookUrl });
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

// Detects the Android application ID from a project on this host, so the
// wizard can prefill the package name from the project path alone (Expo
// app.json first, then app/build.gradle).
app.post(
  '/project/android-package',
  async (req: Request<{}, {}, { projectPath?: string }>, res: Response) => {
    const { projectPath } = req.body;
    if (!projectPath) {
      return res.status(400).json({ status: 'error', message: 'projectPath is required' });
    }
    try {
      const packageName = await detectAndroidPackage(projectPath);
      return res.status(200).json({ packageName: packageName ?? null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      return res.status(500).json({ status: 'error', message });
    }
  },
);

// Starts the detached Android counterpart of /publish. Completion arrives
// through the same authenticated build-finish webhook and polling route.
app.post('/publish/android', async (req: Request<{}, {}, Partial<AndroidPublishRequest>>, res: Response) => {
  const { projectPath, packageName, googleAccessToken, track, secretsDir, webhookUrl } = req.body;
  if (!projectPath || !packageName || !googleAccessToken || !webhookUrl) {
    return res.status(400).json({
      status: 'error',
      message: 'projectPath, packageName, googleAccessToken and webhookUrl are required',
    });
  }
  try {
    const id = await startAndroidPublish({
      projectPath,
      packageName,
      googleAccessToken,
      track,
      secretsDir,
      webhookUrl,
    });
    return res.status(202).json({ publishId: id });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

// The webhook receiver is its own Express app on its own port: the public
// URL the user enters in the UI makes whatever it fronts reachable by anyone
// on the internet, and the main app serves the secret store. Only this app —
// one token-guarded POST route — goes public.
const hooks = express();
const webhookPort = 3001;
hooks.use(express.json({ limit: '1mb' }));

// The build-finish webhook limbuild POSTs once the build reaches a terminal
// state. It goes to the entered webhook URL exactly as provided — nothing is
// appended — so accept the POST on any path and match it to a publish by the
// per-publish token the CLI was given via --webhook-header.
hooks.post('/{*splat}', (req: Request, res: Response) => {
  const id = receivePublishWebhook(req.header('X-Publish-Token'), req.body);
  if (!id) {
    return res.status(404).json({ status: 'error', message: 'Publish not found' });
  }
  console.log(`[publish ${id}] webhook received:`, JSON.stringify(req.body));
  return res.status(204).end();
});

hooks.listen(webhookPort, () => {
  console.log(`Webhook receiver listening at http://localhost:${webhookPort}`);
});
app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});
