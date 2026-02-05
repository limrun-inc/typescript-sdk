import { Limrun, createXCodeSandboxClient } from '@limrun/api';

if (!process.env['LIM_API_KEY']) {
  console.error('Error: Missing required environment variables (LIM_API_KEY).');
  process.exit(1);
}

const lim = new Limrun({ apiKey: process.env['LIM_API_KEY'] });

const args = process.argv.slice(2);
const codeFolder = args.find((arg) => !arg.startsWith('-'));

if (!codeFolder) {
  console.error('Usage: node index.ts <code-folder>');
  console.error('Example: node index.ts ./my-ios-app');
  process.exit(1);
}

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

console.log(`Instance created: https://console.limrun.com/stream/${instance.metadata.id}`);

const sandbox = await createXCodeSandboxClient({
  apiUrl: sandboxUrl,
  token: instance.status.token,
});

// Sync the code to the sandbox
console.log(`Syncing code from ${codeFolder}...`);
await sandbox.sync(codeFolder, { watch: true });

// Function to trigger a build
async function runBuild() {
  console.log('\nStarting xcodebuild...');
  const build = sandbox.xcodebuild();

  // Stream build output
  build.stdout.on('data', (line) => console.log(line));
  build.stderr.on('data', (line) => console.error(line));

  const result = await build;
  console.log(`Build finished with exit code: ${result.exitCode}`);
}
await runBuild();

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

let building = false;
process.stdin.on('data', async (key: string) => {
  if (key === 'q' || key === '\u0003') {
    // 'q' or Ctrl+C
    console.log('\nExiting...');
    process.exit(0);
  }

  if (key === 'b') {
    if (building) {
      console.log('Build already in progress, please wait...');
      return;
    }
    building = true;
    await runBuild();
    building = false;
    console.log('\nPress "b" to trigger another build, or "q" to quit.');
  }
});
console.log('\nPress "b" to trigger another build, or "q" to quit.');
