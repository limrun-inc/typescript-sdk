import express, { Request, Response } from 'express';
import cors from 'cors';
import { Limrun } from '@limrun/api';
import { AndroidInstanceCreateParams, IosInstanceCreateParams } from '@limrun/api/resources';

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

app.post(
  '/create-instance',
  async (
    req: Request<
      {},
      {},
      {
        webSessionId: string;
        platform: 'android' | 'ios';
        iosModel?: IosInstanceCreateParams.Spec['model'];
        withExpoGo54?: boolean;
      }
    >,
    res: Response,
  ) => {
    try {
      const { webSessionId, platform = 'android', iosModel = 'iphone', withExpoGo54 = true } = req.body;
      const forwardedIp =
        req.headers['x-forwarded-for'] instanceof Array ?
          req.headers['x-forwarded-for'].join(',')
        : req.headers['x-forwarded-for'];
      const clientIp = forwardedIp ? forwardedIp.split(',')[0] : req.socket.remoteAddress;

      if (platform === 'ios') {
        // iOS instance creation
        const spec: IosInstanceCreateParams.Spec = {
          model: iosModel,
        };
        if (withExpoGo54) {
          spec.initialAssets = [
            {
              kind: 'App',
              source: 'AssetName',
              assetName: 'appstore/Expo-Go-54.0.6.tar.gz',
            },
          ];
        }
        // iOS doesn't support OSVersion clue, only ClientIP
        if (clientIp && clientIp !== '::1' && clientIp !== '127.0.0.1') {
          console.log({ clientIp }, 'Adding client IP as scheduling clue (iOS)');
          spec.clues = [
            {
              kind: 'ClientIP',
              clientIp,
            },
          ];
        }
        console.time('create');
        const result = await limrun.iosInstances.create({
          reuseIfExists: true,
          spec,
          metadata: { labels: { webSessionId } },
        });
        console.timeEnd('create');

        return res.status(200).json({
          id: result.metadata.id,
          webrtcUrl: result.status.endpointWebSocketUrl,
          token: result.status.token,
        });
      } else {
        // Android instance creation
        const spec: AndroidInstanceCreateParams.Spec = {};
        if (withExpoGo54) {
          spec.initialAssets = [
            {
              kind: 'App',
              source: 'AssetName',
              assetName: 'appstore/Expo-Go-54.0.6.apk',
            },
          ];
        }

        if (clientIp && clientIp !== '::1' && clientIp !== '127.0.0.1') {
          console.log({ clientIp }, 'Adding client IP as scheduling clue (Android)');
          spec.clues = [
            {
              kind: 'ClientIP',
              clientIp,
            },
          ];
        }

        const result = await limrun.androidInstances.create({
          spec,
          metadata: { labels: { webSessionId } },
        });

        return res.status(200).json({
          id: result.metadata.id,
          webrtcUrl: result.status.endpointWebSocketUrl,
          token: result.status.token,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      return res.status(500).json({
        status: 'error',
        message: 'Internal server error: ' + message,
      });
    }
  },
);

app.post(
  '/stop-instance',
  async (req: Request<{}, {}, { instanceId: string; platform: 'android' | 'ios' }>, res: Response) => {
    try {
      const { instanceId, platform = 'android' } = req.body;
      if (!instanceId) {
        return res.status(400).json({
          status: 'error',
          message: 'Instance ID is required',
        });
      }

      console.log(`Stopping ${platform} instance`, instanceId);

      if (platform === 'ios') {
        await limrun.iosInstances.delete(instanceId);
      } else {
        await limrun.androidInstances.delete(instanceId);
      }

      console.log('Instance stopped successfully');

      return res.status(200).json({
        status: 'success',
        message: 'Instance stopped successfully',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      return res.status(500).json({
        status: 'error',
        message: 'Failed to stop instance: ' + message,
      });
    }
  },
);

app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});
