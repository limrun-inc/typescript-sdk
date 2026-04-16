import http from 'node:http';
import Limrun from '@limrun/api';

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}
const args = process.argv.slice(2);
const codeFolder = args.find((arg) => !arg.startsWith('-'));

if (!codeFolder) {
  console.error('Usage: node index.ts <code-folder>');
  console.error('Example: node index.ts ./my-ios-app');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });

// Create a standalone xcode instance
console.log('Creating Xcode instance...');
const xcodeInstance = await lim.xcodeInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'xcode-instance-example',
    },
  },
});

// Create a client for it
const xcode = await lim.xcodeInstances.createClient({ instance: xcodeInstance });
// Sync the code
console.log(`Syncing code from ${codeFolder}...`);
await xcode.sync(codeFolder);

// Function to trigger a build with optional artifact upload
async function runBuild(onLine: (line: string) => void, opts?: {sdk?: 'iphonesimulator' | 'iphoneos', assetName?: string}): Promise<number> {
  console.log('Starting xcodebuild...');
  const build = xcode.xcodebuild(opts?.sdk ? { sdk: opts.sdk } : undefined, opts?.assetName ? { upload: { assetName: opts.assetName } } : undefined);

  build.command.on('data', (line) => {
    console.log('Executing command: ', line.toString());
  });
  build.stdout.on('data', (line) => {
    onLine(line.toString());
  });
  build.stderr.on('data', (line) => {
    onLine(line.toString());
  });

  const result = await build;
  console.log(`Build finished with exit code: ${result.exitCode}`);
  if (result.signedDownloadUrl) {
    console.log(`Build artifact download URL: ${result.signedDownloadUrl}`);
  }
  return result.exitCode;
}

// Run initial build
await runBuild((line) => console.log(line));

const httpServer = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/xcodebuild')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sdk = url.searchParams.get('sdk') as 'iphonesimulator' | 'iphoneos' | undefined;
    const assetName = url.searchParams.get('assetName');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
    try {
      await runBuild((line) => {
        res.write(line + '\n');
        console.log(line);
      }, { sdk, assetName: assetName ?? undefined });
      res.end();
    } catch (err) {
      res.write(`\nError: ${String(err)}\n`);
      res.end();
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.write('Not found');
  res.end();
  return;
});

const port = 3000;
httpServer.listen(port, () => {
  console.log('');
  console.log('--------------------------------');
  console.log(`Files are auto-synced. Trigger a simulator build:`);
  console.log(`$ curl http://localhost:${port}/xcodebuild`);
  console.log('--------------------------------');
  console.log('Trigger a real device build and get the IPA file:')
  console.log(`$ curl http://localhost:${port}/xcodebuild?sdk=iphoneos&assetName=device-build.ipa`);
  console.log('--------------------------------');
  console.log("Tip: Use attachSimulator() for hot-reloading builds on a simulator for fast iteration. Alternatively, create the simulator with sandbox.xcode.enabled=true")
});
