import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Limrun from '@limrun/api';

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });

const args = process.argv.slice(2);
const codeFolder = args.find((arg) => !arg.startsWith('-'));
const withSimulator = args.includes('--simulator');
const assetNameArg = args.find((arg) => arg.startsWith('--asset-name='));
const assetName = assetNameArg?.split('=')[1];

if (!codeFolder) {
  console.error('Usage: node index.ts <code-folder> [--asset-name=<name>] [--simulator]');
  console.error('Example: node index.ts ./my-ios-app --asset-name=my-app-build');
  console.error('Example: node index.ts ./my-ios-app --simulator');
  process.exit(1);
}

if (assetNameArg && !assetName) {
  console.error('Error: --asset-name requires a value (e.g. --asset-name=my-app-build)');
  process.exit(1);
}

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

// Optionally attach a simulator
let iosInstance: Limrun.IosInstance | undefined;
if (withSimulator) {
  console.log('Creating iOS simulator and attaching...');
  iosInstance = await lim.iosInstances.create({
    wait: true,
    reuseIfExists: true,
    metadata: {
      labels: {
        name: 'xcode-instance-example-simulator',
      },
    },
  });
  await xcode.attachSimulator(iosInstance);
  console.log('Simulator attached.');
}

// Sync the code
console.log(`Syncing code from ${codeFolder}...`);
await xcode.sync(codeFolder);

// Function to trigger a build with optional artifact upload
async function runBuild(onLine: (line: string) => void): Promise<number> {
  console.log('Starting xcodebuild...');
  const build = assetName ? xcode.xcodebuild({}, { upload: { assetName } }) : xcode.xcodebuild();

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
  return result.exitCode;
}

// Run initial build
await runBuild((line) => console.log(line));

// Create a fresh MCP server + transport per request (stateless mode)
function createServer() {
  const mcp = new McpServer({ name: 'xcodebuild', version: '1.0.0' });
  mcp.registerTool(
    'build',
    {
      title: 'xcodebuild',
      description:
        'Runs xcodebuild on the remote Xcode instance and optionally installs the app on the simulator. Returns the build output.',
    },
    async () => {
      let buffer: string[] = [];
      await runBuild((line) => buffer.push(line));
      return { content: [{ type: 'text', text: buffer.join('\n') }] };
    },
  );
  return mcp;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/xcodebuild') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
    try {
      await runBuild((line) => {
        res.write(line + '\n');
        console.log(line);
      });
      res.end();
    } catch (err) {
      res.write(`\nError: ${String(err)}\n`);
      res.end();
    }
    return;
  }

  // MCP starts here.
  const body = await new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
  const parsedBody = body ? JSON.parse(body) : undefined;

  const mcp = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
  res.on('close', () => {
    transport.close();
    mcp.close();
  });
});

const port = 3000;
httpServer.listen(port, () => {
  console.log('');
  console.log('--------------------------------');
  if (iosInstance) {
    console.log(
      `Access your iOS simulator here: https://console.limrun.com/stream/${iosInstance.metadata.id}`,
    );
    console.log('--------------------------------');
  }
  console.log(`Files are auto-synced. Trigger a build with:`);
  console.log(`$ curl http://localhost:${port}/xcodebuild`);
  console.log('--------------------------------');
  console.log(`Also, an MCP server is listening on http://localhost:${port}`);
  console.log(`Add the following to your .mcp.json file:`);
  console.log(`{
  "mcpServers": {
    "xcode": {
      "url": "http://localhost:3000/"
    }
  }
}`);
  console.log('--------------------------------');
  console.log(`For Claude Code:`);
  console.log(`$ claude mcp add xcode --transport http http://localhost:3000`);
  console.log('--------------------------------');
});
