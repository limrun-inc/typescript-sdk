import express, { Request, Response } from 'express';
import cors from 'cors';
import { Limrun } from '@limrun/api';
import { XcodeInstanceCreateParams } from '@limrun/api/resources/xcode-instances';

const apiKey = process.env['LIM_API_KEY'];

if (!apiKey) {
  console.error('Error: Missing required environment variable (LIM_API_KEY).');
  process.exit(1);
}

const limrun = new Limrun({ apiKey });

const app = express();
const port = 3000;
app.use(express.json());
app.use(cors());

// Provision an Xcode build sandbox and hand its per-instance credentials to the
// browser. The `token` is scoped to this single sandbox, so it is safe to expose
// to the frontend — it cannot touch the rest of your account.
app.post('/create-sandbox', async (req: Request<{}, {}, { webSessionId?: string }>, res: Response) => {
  try {
    const { webSessionId } = req.body;
    const forwardedIp =
      req.headers['x-forwarded-for'] instanceof Array ?
        req.headers['x-forwarded-for'].join(',')
      : req.headers['x-forwarded-for'];
    const clientIp = forwardedIp ? forwardedIp.split(',')[0] : req.socket.remoteAddress;

    const params: XcodeInstanceCreateParams = {
      // Return only once the sandbox is ready to accept HTTP calls.
      wait: true,
      // Reuse a matching sandbox instead of spinning up a new one each time.
      reuseIfExists: true,
      spec: {},
    };

    if (clientIp && clientIp !== '::1' && clientIp !== '127.0.0.1') {
      console.log({ clientIp }, 'Adding client IP as scheduling clue');
      params.spec!.clues = [{ kind: 'ClientIP', clientIp }];
    }

    if (webSessionId) {
      params.metadata = { labels: { webSessionId } };
    }

    console.time('create');
    const instance = await limrun.xcodeInstances.create(params);
    console.timeEnd('create');

    if (!instance.status.apiUrl) {
      return res.status(502).json({
        status: 'error',
        message: 'Sandbox is not ready yet (no apiUrl). Try again in a moment.',
      });
    }

    return res.status(200).json({
      id: instance.metadata.id,
      apiUrl: instance.status.apiUrl,
      token: instance.status.token,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({
      status: 'error',
      message: 'Failed to create sandbox: ' + message,
    });
  }
});

app.post('/stop-sandbox', async (req: Request<{}, {}, { sandboxId: string }>, res: Response) => {
  try {
    const { sandboxId } = req.body;
    if (!sandboxId) {
      return res.status(400).json({ status: 'error', message: 'sandboxId is required' });
    }

    console.log('Stopping Xcode sandbox', sandboxId);
    await limrun.xcodeInstances.delete(sandboxId);
    console.log('Sandbox stopped successfully');

    return res.status(200).json({ status: 'success', message: 'Sandbox stopped successfully' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return res.status(500).json({
      status: 'error',
      message: 'Failed to stop sandbox: ' + message,
    });
  }
});

app.listen(port, () => {
  console.log(`Express server listening at http://localhost:${port}`);
});
