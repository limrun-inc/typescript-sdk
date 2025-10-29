import express, { Request, Response } from 'express';
import cors from 'cors';
import { Limrun } from '@limrun/api';
import { AndroidInstanceCreateParams } from '@limrun/api/resources';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

app.post('/get-upload-url', async (req: Request<{}, {}, { filename: string }>, res: Response) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({
        status: 'error',
        message: 'Filename is required',
      });
    }

    console.log('Getting upload URL for', filename);
    const asset = await limrun.assets.getOrCreate({ name: filename });
    
    return res.status(200).json({
      uploadUrl: asset.signedUploadUrl,
      assetName: asset.name,
      assetId: asset.id,
      md5: asset.md5,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get upload URL: ' + message,
    });
  }
});

app.post('/create-instance', async (req: Request<{}, {}, { assetNames?: string[]; androidVersion?: string }>, res: Response) => {
  const spec: AndroidInstanceCreateParams.Spec = {
    ...(req.body.assetNames?.length ?
      {
        initialAssets: req.body.assetNames.map((assetName) => ({
          kind: 'App',
          source: 'AssetName',
          assetName,
        })),
      }
    : {}),
  };
  
  const androidVersion = req.body.androidVersion || '14';
  const clues: AndroidInstanceCreateParams.Spec.Clue[] = [
    {
      kind: 'OSVersion',
      osVersion: androidVersion,
    }
  ];
  
  const forwardedIp =
    req.headers['x-forwarded-for'] instanceof Array ?
      req.headers['x-forwarded-for'].join(',')
    : req.headers['x-forwarded-for'];
  const clientIp = forwardedIp ? forwardedIp.split(',')[0] : req.socket.remoteAddress;
  if (clientIp && clientIp !== '::1' && clientIp !== '127.0.0.1') {
    console.log({ clientIp }, 'Adding client IP as scheduling clue');
    clues.push({
      kind: 'ClientIP',
      clientIp,
    });
  }
  
  spec.clues = clues;
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
