import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Limrun, createXCodeSandboxClient } from '@limrun/api';

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'], baseURL: 'https://api-staging.limrun.dev' });

const args = process.argv.slice(2);
const codeFolder = args.find((arg) => !arg.startsWith('-'));

if (!codeFolder) {
  console.error('Usage: node index.ts <code-folder>');
  console.error('Example: node index.ts ./my-ios-app');
  process.exit(1);
}
console.log('Creating iOS instance with an XCode sandbox...');
const instance = await lim.iosInstances.create({
  wait: true,
  reuseIfExists: true,
  metadata: {
    labels: {
      name: 'ios-native-build-example',
    },
  },
  spec: {
    sandbox: {
      xcode: {
        enabled: true,
      },
    },
  },
});

const sandboxUrl = instance.status.sandbox?.xcode?.url;
if (!sandboxUrl) {
  console.error('Error: Xcode sandbox URL not available');
  process.exit(1);
}

const sandbox = await createXCodeSandboxClient({
  apiUrl: sandboxUrl,
  token: instance.status.token,
});

// Sync the code to the sandbox
console.log(`Syncing code from ${codeFolder}...`);
await sandbox.sync(codeFolder, { watch: true });

// Function to trigger a build
async function runBuild(onLine: (line: string) => void): Promise<number> {
  console.log('Starting xcodebuild...');
  const build = sandbox.xcodebuild();

  build.stdout.on('data', (line) => { onLine(line.toString()); });
  build.stderr.on('data', (line) => { onLine(line.toString()); });

  const result = await build;
  console.log(`Build finished with exit code: ${result.exitCode}`);
  return result.exitCode;
}

// Run initial build
await runBuild((line) => console.log(line));

// Create a fresh MCP server + transport per request (stateless mode)
function createServer() {
  const mcp = new McpServer({ name: 'xcodebuild', version: '1.0.0' });
  mcp.registerTool('build', {
    title: 'xcodebuild',
    description: 'Runs xcodebuild and installs the app on the remote simulator. Returns the build output.',
  }, async () => {
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
      await runBuild((line) => { res.write(line + '\n'); console.log(line); });
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
    req.on('data', (chunk) => { data += chunk; });
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
  console.log("");
  console.log("");
  console.log("");
  console.log("--------------------------------");
  console.log(`Access your iOS simulator here: https://console.limrun.com/stream/${instance.metadata.id}`);
  console.log("--------------------------------");
  console.log(`Files are auto-synced. Trigger a build with:`);
  console.log(`$ curl http://localhost:${port}/xcodebuild`);
  console.log("--------------------------------");
  console.log(`Also, an MCP server is listening on http://localhost:${port}`);

  console.log(`Add the following to your .mcp.json file:`);
  console.log(`{
  "mcpServers": {
    "xcode": {
      "url": "http://localhost:3000/"
    }
  }
}`);
  console.log("--------------------------------");
  console.log(`For Claude Code:`);
  console.log(`$ claude mcp add xcode --transport http http://localhost:3000`);
  console.log("--------------------------------");
});
