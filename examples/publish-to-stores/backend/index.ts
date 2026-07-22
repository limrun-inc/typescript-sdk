import express, { Request, Response } from 'express';
import cors from 'cors';
import { attachAppleRelayProxy } from './relay-proxy.js';
import { deleteSecret, getSecret, listSecrets, putSecret } from './secret-store.js';
import { streamPublish, type PublishRequest } from './publish.js';
import { streamAndroidPublish, type AndroidPublishRequest } from './publish-android.js';

// Used for the Apple relay proxy and by the lim CLI spawned for publishes.
const apiKey = process.env['LIM_API_KEY'];
if (!apiKey) {
  console.error('Error: Missing required environment variable (LIM_API_KEY).');
  process.exit(1);
}

const registryUrl = process.env['LIM_REGISTRY_ENDPOINT'] ?? 'https://registry.limrun.com';

const app = express();
const port = 3000;
app.use(express.json({ limit: '10mb' }));
app.use(cors());

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

// Runs `lim xcode build --upload-to-testflight` with the stored signing
// material and streams its output back as Server-Sent Events. The CLI
// provisions (or reuses) its own Xcode instance — the only point in the
// whole flow where one exists.
app.post('/publish', async (req: Request<{}, {}, Partial<PublishRequest>>, res: Response) => {
  const { projectPath, method, teamId, bundleId, scheme } = req.body;
  if (!projectPath || !teamId || !bundleId || (method !== 'testflight' && method !== 'appstore')) {
    return res.status(400).json({
      status: 'error',
      message: 'projectPath, teamId, bundleId and method (testflight | appstore) are required',
    });
  }
  await streamPublish({ projectPath, method, teamId, bundleId, scheme }, res);
});

// The Play Store counterpart of /publish: provisions a gradle instance via
// the SDK, builds and signs the AAB with the escrowed upload keystore, and
// publishes it with the browser-minted Google access token, which rides
// this one request and is never stored. Streams SSE like /publish.
app.post('/publish/android', async (req: Request<{}, {}, Partial<AndroidPublishRequest>>, res: Response) => {
  const { projectPath, packageName, googleAccessToken, track } = req.body;
  if (!projectPath || !packageName || !googleAccessToken) {
    return res.status(400).json({
      status: 'error',
      message: 'projectPath, packageName and googleAccessToken are required',
    });
  }
  await streamAndroidPublish({ projectPath, packageName, googleAccessToken, track }, apiKey, res);
});

const server = app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});

// The Connect phase's Apple relay: the browser speaks the relay protocol
// against this backend, which pipes it to Limrun's registry with the API
// key attached. The key never reaches the browser, and since the relay is
// not tied to any instance, no Xcode instance exists until a publish
// actually spawns `lim xcode build`.
attachAppleRelayProxy(server, { registryUrl, apiKey, log: console.log });
