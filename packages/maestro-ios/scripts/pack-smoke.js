'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'limrun-maestro-ios-pack-'));

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function main() {
  const pack = run('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: root });
  const packed = JSON.parse(pack.stdout)[0];
  const tarball = path.join(tmp, packed.filename);
  assert.ok(fs.existsSync(tarball), `package tarball was not created: ${tarball}`);
  const packedFiles = new Set(packed.files.map((file) => file.path));
  for (const expected of [
    'README.md',
    'package.json',
    'bin/limrun-maestro-ios.js',
    'dist/index.js',
    'dist/cli.js',
    'runner/build/libs/limrun-maestro-ios-runner.jar',
  ]) {
    assert.ok(packedFiles.has(expected), `packed artifact is missing ${expected}`);
  }
  assert.ok(packed.unpackedSize < 220 * 1024 * 1024, `packed artifact is unexpectedly large: ${packed.unpackedSize}`);

  const installRoot = path.join(tmp, 'install');
  fs.mkdirSync(installRoot, { recursive: true });
  run('npm', ['install', '--prefix', installRoot, tarball], { cwd: tmp });

  const packageRoot = path.join(installRoot, 'node_modules', '@limrun', 'maestro-ios');
  const bin = path.join(packageRoot, 'bin', 'limrun-maestro-ios.js');
  const jar = path.join(packageRoot, 'runner', 'build', 'libs', 'limrun-maestro-ios-runner.jar');

  assert.ok(fs.existsSync(bin), `installed CLI is missing: ${bin}`);
  assert.ok(fs.existsSync(jar), `installed runner JAR is missing: ${jar}`);

  const version = run(process.execPath, [bin, '--version'], { cwd: installRoot });
  assert.match(version.stdout, /2\.5\.1-lim\.1/);

  const help = run(process.execPath, [bin, '--help'], { cwd: installRoot });
  assert.match(help.stdout, /--test-output-dir/);
  assert.match(help.stdout, /LIMRUN_IOS_API_URL/);

  const jarVersion = run('java', ['-jar', jar, '--version'], { cwd: installRoot });
  assert.match(jarVersion.stdout, /Maestro 2\.5\.1/);

  // Exercise the installed CLI far enough to prove it loads without opening a device connection.
  const missingFlow = spawnSync(process.execPath, [bin, 'test', path.join(tmp, 'missing.yaml')], {
    cwd: installRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LIMRUN_IOS_API_URL: 'https://example.invalid',
      LIMRUN_IOS_TOKEN: 'lim_test',
    },
  });
  assert.notEqual(missingFlow.status, 0);
  assert.match(`${missingFlow.stdout}\n${missingFlow.stderr}`, /Maestro flow does not exist/);

  await runInstalledJarFlow(jar, installRoot);

  console.log('maestro-ios package pack smoke passed');
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

async function runInstalledJarFlow(jar, cwd) {
  const flowPath = path.join(tmp, 'pack-smoke.yaml');
  const screenshotsDir = path.join(tmp, 'screenshots');
  fs.writeFileSync(
    flowPath,
    [
      'appId: com.example.packsmoke',
      '---',
      '- launchApp:',
      '    stopApp: true',
      '    permissions: {}',
      '- assertVisible: ${MAESTRO_FILENAME}',
      '- assertVisible: ${MAESTRO_PACK_SMOKE}',
      '- assertVisible: ${MAESTRO_DEVICE_UDID}',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const bridge = createFakeBridge();
  await listen(bridge.server);
  try {
    const bridgeUrl = `http://127.0.0.1:${bridge.server.address().port}`;
    await runAsync('java', ['-jar', jar, '--bridge-url', bridgeUrl, '--device-id', 'PACK-SMOKE-UDID', '--flow', flowPath, '--screenshots-dir', screenshotsDir], {
      cwd,
      env: {
        ...process.env,
        MAESTRO_PACK_SMOKE: 'Injected Env Smoke',
      },
    });
    assert.ok(bridge.routes.has('contentDescriptor'), 'installed runner did not request the Maestro hierarchy');
  } finally {
    await closeServer(bridge.server);
  }
}

function createFakeBridge() {
  const routes = new Set();
  const server = http.createServer(async (req, res) => {
    const route = (req.url || '/').replace(/^\//, '');
    routes.add(route);
    await readRequest(req);
    sendJson(res, responseForRoute(route));
  });
  return { routes, server };
}

function responseForRoute(route) {
  switch (route) {
    case 'open':
    case 'close':
    case 'stopApp':
    case 'launchApp':
    case 'setPermissions':
    case 'waitForAppToSettle':
      return {};
    case 'deviceInfo':
      return { widthPixels: 390, heightPixels: 844, widthGrid: 390, heightGrid: 844 };
    case 'contentDescriptor':
      return {
        attributes: { bounds: '[0,0][390,844]' },
        children: [
          {
            attributes: {
              accessibilityText: 'Limrun Pack Smoke',
              bounds: '[0,0][390,44]',
              class: 'StaticText',
              enabled: 'true',
              focused: 'false',
              hintText: '',
              'resource-id': 'pack-smoke-label',
              selected: 'false',
              text: 'Limrun Pack Smoke',
              title: 'Limrun Pack Smoke',
              value: '',
            },
            children: [],
            clickable: false,
            enabled: true,
            focused: false,
            selected: false,
          },
          {
            attributes: {
              accessibilityText: 'pack-smoke',
              bounds: '[0,44][390,88]',
              class: 'StaticText',
              enabled: 'true',
              focused: 'false',
              hintText: '',
              'resource-id': 'pack-smoke-filename',
              selected: 'false',
              text: 'pack-smoke',
              title: 'pack-smoke',
              value: '',
            },
            children: [],
            clickable: false,
            enabled: true,
            focused: false,
            selected: false,
          },
          {
            attributes: {
              accessibilityText: 'Injected Env Smoke',
              bounds: '[0,88][390,132]',
              class: 'StaticText',
              enabled: 'true',
              focused: 'false',
              hintText: '',
              'resource-id': 'pack-smoke-injected-env',
              selected: 'false',
              text: 'Injected Env Smoke',
              title: 'Injected Env Smoke',
              value: '',
            },
            children: [],
            clickable: false,
            enabled: true,
            focused: false,
            selected: false,
          },
          {
            attributes: {
              accessibilityText: 'PACK-SMOKE-UDID',
              bounds: '[0,132][390,176]',
              class: 'StaticText',
              enabled: 'true',
              focused: 'false',
              hintText: '',
              'resource-id': 'pack-smoke-device-id',
              selected: 'false',
              text: 'PACK-SMOKE-UDID',
              title: 'PACK-SMOKE-UDID',
              value: '',
            },
            children: [],
            clickable: false,
            enabled: true,
            focused: false,
            selected: false,
          },
        ],
      };
    default:
      return {};
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    req.on('data', () => undefined);
    req.on('end', resolve);
    req.on('error', reject);
  });
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}
