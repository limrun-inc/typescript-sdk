import express, { Request, Response } from 'express';
import cors from 'cors';
import { Limrun } from '@limrun/api';
import { AndroidInstanceCreateParams } from '@limrun/api/resources';

const apiKey = process.env['LIM_TOKEN'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_TOKEN).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

app.post('/create-instance', async (req: Request<{}, {}, { assets?: { path: string }[] }>, res: Response) => {
  const downloadUrls: string[] = [];
  if (req.body.assets?.length) {
    try {
      await Promise.all(
        req.body.assets?.map(async (asset) => {
          console.time('getOrUpload-' + asset.path);
          console.log('Ensuring asset is in place', asset.path);
          const assetResponse = await limrun.assets.getOrUpload({ path: asset.path });
          downloadUrls.push(assetResponse.signedDownloadUrl);
          console.timeEnd('getOrUpload-' + asset.path);
        }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      return res.status(500).json({
        status: 'error',
        message: 'Failed to upload assets: ' + message,
      });
    }
  }
  const spec: AndroidInstanceCreateParams.Spec = {
    ...(downloadUrls.length > 0 ?
        {
          initialAssets: downloadUrls.map((url) => ({
            kind: 'App',
            source: 'URL',
            url,
          })),
        }
      : {})
  }
  const forwardedIp = req.headers['x-forwarded-for'] instanceof Array ? req.headers['x-forwarded-for'].join(",") : req.headers['x-forwarded-for'];
  const clientIp = forwardedIp ? forwardedIp.split(",")[0] : req.socket.remoteAddress;
  if (clientIp && clientIp !== '::1' && clientIp !== '127.0.0.1') {
    console.log({ clientIp }, 'Adding client IP as scheduling clue');
    spec.clues = [{
      kind: 'ClientIP',
      clientIp,
    }];
  }
  try {
    console.time('create');
    const result = await limrun.androidInstances.create({ spec });
    console.timeEnd('create');
    return res.status(200).json({
      id: result.metadata.id,
      webrtcUrl: result.status.endpointWebSocketUrl,
      token: result.status.token,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error: ' + message,
    });
  }
});

app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});
