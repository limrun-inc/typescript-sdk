import cors from 'cors';
import express, { Request, Response } from 'express';
import Limrun from '@limrun/api';
import { getInstallStatus, receiveInstallWebhook, startInstall, type InstallRequest } from './install.js';
import { DEFAULT_SECRETS_DIR, deleteSecret, getSecret, listSecrets, putSecret } from './secret-store.js';

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

// Apple credentials are created in the browser through the registry relay.
// The long-lived API key remains here; this token can only open that relay.
app.post('/session', async (_req: Request, res: Response) => {
  try {
    const session = await limrun.scopedTokens.create({ scopes: ['applerelay:*:connect'] });
    return res.status(200).json({
      token: session.token,
      expiresAt: session.expiresAt,
      registryUrl,
      // The store directory used when requests don't name one; the UI
      // shows it as the default of its secrets-directory field.
      secretsDir: DEFAULT_SECRETS_DIR,
    });
  } catch (error: unknown) {
    return res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'An unknown error occurred',
    });
  }
});

// Device selection/pairing starts with device-only authority. Only after the
// matching build webhook succeeds can the install ID be exchanged for read
// access to that build's exact asset.
app.post('/device-session', async (req: Request<{}, {}, { installId?: string }>, res: Response) => {
  try {
    const scopes = ['device:*:install'];
    let assetId: string | undefined;
    let assetName: string | undefined;
    if (req.body.installId) {
      const install = getInstallStatus(req.body.installId);
      if (!install) return res.status(404).json({ status: 'error', message: 'Install build not found' });
      if (install.state !== 'succeeded') {
        return res.status(409).json({
          status: 'error',
          message: 'The install build must finish successfully before its asset can be authorized.',
        });
      }
      const assets = await limrun.assets.list({ nameFilter: install.assetName });
      const asset = assets.find((candidate) => candidate.name === install.assetName && candidate.md5);
      if (!asset) {
        return res.status(404).json({
          status: 'error',
          message: `The uploaded asset ${install.assetName} is not available yet.`,
        });
      }
      assetId = asset.id;
      assetName = asset.name;
      scopes.push(`asset:${asset.id}:read`);
    }
    const session = await limrun.scopedTokens.create({ scopes });
    return res.status(200).json({
      token: session.token,
      expiresAt: session.expiresAt,
      registryUrl,
      assetId,
      assetName,
    });
  } catch (error: unknown) {
    return res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'An unknown error occurred',
    });
  }
});

// The optional `dir` query parameter selects the store directory; absent
// or empty means the backend default.
function secretsDirOf(req: Request): string | undefined {
  const dir = req.query['dir'];
  return typeof dir === 'string' && dir.trim() ? dir : undefined;
}

app.get('/secrets', async (req: Request, res: Response) => {
  try {
    const secrets = await listSecrets(secretsDirOf(req));
    return res.status(200).json(secrets.map(({ type, name, createdAt }) => ({ type, name, createdAt })));
  } catch (error: unknown) {
    return res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'An unknown error occurred',
    });
  }
});

app.get('/secrets/:type/:name', async (req: Request<{ type: string; name: string }>, res: Response) => {
  try {
    const secret = await getSecret(req.params.type, req.params.name, secretsDirOf(req));
    return secret ?
        res.status(200).json(secret)
      : res.status(404).json({ status: 'error', message: 'Secret not found' });
  } catch (error: unknown) {
    return res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'An unknown error occurred',
    });
  }
});

app.put(
  '/secrets/:type/:name',
  async (
    req: Request<{ type: string; name: string }, {}, { data?: Record<string, string> }>,
    res: Response,
  ) => {
    try {
      if (!req.body.data || typeof req.body.data !== 'object') {
        return res.status(400).json({ status: 'error', message: 'Body must contain a data object' });
      }
      return res
        .status(200)
        .json(await putSecret(req.params.type, req.params.name, req.body.data, secretsDirOf(req)));
    } catch (error: unknown) {
      return res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : 'An unknown error occurred',
      });
    }
  },
);

app.delete('/secrets/:type/:name', async (req: Request<{ type: string; name: string }>, res: Response) => {
  try {
    await deleteSecret(req.params.type, req.params.name, secretsDirOf(req));
    return res.status(200).json({ status: 'success' });
  } catch (error: unknown) {
    return res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'An unknown error occurred',
    });
  }
});

// The webhook URL comes from the UI with each request: limbuild runs inside
// Limrun's cloud and rejects private or IP-literal callback URLs, so it must
// be a public URL that forwards to the webhook receiver's port 3001 (e.g.
// from `ngrok http 3001`).
app.post('/install', async (req: Request<{}, {}, Partial<InstallRequest>>, res: Response) => {
  const { projectPath, teamId, bundleId, deviceUDID, scheme, secretsDir, webhookUrl } = req.body;
  if (!projectPath || !teamId || !bundleId || !deviceUDID || !webhookUrl) {
    return res.status(400).json({
      status: 'error',
      message: 'projectPath, teamId, bundleId, deviceUDID and webhookUrl are required',
    });
  }
  try {
    const installId = await startInstall({
      projectPath,
      teamId,
      bundleId,
      deviceUDID,
      scheme,
      secretsDir,
      webhookUrl,
    });
    return res.status(202).json({ installId });
  } catch (error: unknown) {
    return res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'An unknown error occurred',
    });
  }
});

app.get('/install/:id', (req: Request<{ id: string }>, res: Response) => {
  const status = getInstallStatus(req.params.id);
  return status ?
      res.status(200).json(status)
    : res.status(404).json({ status: 'error', message: 'Install build not found' });
});

// Only this token-guarded webhook app is exposed publicly, through the
// URL entered in the UI. The secret store and scoped-token minting routes
// remain local.
const hooks = express();
const webhookPort = 3001;
hooks.use(express.json({ limit: '1mb' }));
// limbuild POSTs to the entered webhook URL exactly as provided — nothing is
// appended — so accept the POST on any path and match it to an install by
// the per-install token the CLI was given via --webhook-header.
hooks.post('/{*splat}', (req: Request, res: Response) => {
  const id = receiveInstallWebhook(req.header('X-Install-Token'), req.body);
  if (!id) {
    return res.status(404).json({ status: 'error', message: 'Install build not found' });
  }
  console.log(`[install ${id}] webhook received:`, JSON.stringify(req.body));
  return res.status(204).end();
});

hooks.listen(webhookPort, () => {
  console.log(`Webhook receiver listening at http://localhost:${webhookPort}`);
});
app.listen(port, () => {
  console.log(`Device install backend listening at http://localhost:${port}`);
});
