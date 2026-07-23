import express, { Request, Response } from 'express';
import cors from 'cors';
import Limrun from '@limrun/api';

const apiKey = process.env['LIM_API_KEY'];
const registryUrl = process.env['LIM_REGISTRY_ENDPOINT'] ?? 'https://registry.limrun.com';

if (!apiKey) {
  console.error('Error: Missing required environment variable (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

// Mints a short-lived scoped token so the browser can talk to Limrun's
// registry directly for pairing and installs. The API key never leaves this
// backend; the token it mints can only open the device relay and read the
// granted assets, and it expires on its own.
//
// Pass assetName to scope the token to that single asset. Without it the
// token can read any asset in the organization, which is convenient for this
// demo where the asset name is typed in the browser.
app.post('/session', async (req: Request<{}, {}, { assetName?: string }>, res: Response) => {
  try {
    const scopes = ['device:*:install'];
    const assetName = req.body?.assetName?.trim();
    if (assetName) {
      const assets = await limrun.assets.list({ nameFilter: assetName });
      const asset = assets[0];
      if (!asset) {
        return res.status(404).json({ status: 'error', message: `No asset named ${assetName} found` });
      }
      scopes.push(`asset:${asset.id}:read`);
    } else {
      scopes.push('asset:*:read');
    }
    const session = await limrun.scopedTokens.create({ scopes });
    return res.status(200).json({ token: session.token, expiresAt: session.expiresAt, registryUrl });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({ status: 'error', message });
  }
});

app.listen(port, () => {
  console.log(`Session backend listening at http://localhost:${port}`);
});
