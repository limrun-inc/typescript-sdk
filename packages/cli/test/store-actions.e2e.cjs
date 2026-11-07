const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, writeFile, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const forge = require('node-forge');
const exec = promisify(execFile);
const cli = path.resolve(__dirname, '../bin/run.js');

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'lim-store-e2e-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Isolate the real CLI's local files without changing the developer's home.
  const preload = path.join(directory, 'home.cjs');
  await writeFile(preload, `require('node:os').homedir = () => ${JSON.stringify(directory)};\n`);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(500).end('Unexpected network request');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    ...process.env,
    LIM_DISABLE_TELEMETRY: '1',
    LIM_API_KEY: 'lim-e2e-unused',
    LIM_API_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
  };
  async function run(args, succeeds = true) {
    let result;
    try {
      result = await exec(process.execPath, ['--require', preload, cli, ...args, '--json'], {
        cwd: directory,
        env,
        timeout: 15000,
      });
      assert.ok(succeeds, 'Command unexpectedly succeeded');
    } catch (error) {
      if (succeeds) throw error;
      assert.equal(typeof error.code, 'number');
      result = error;
    }
    assert.deepEqual(requests, [], 'Local action or validation contacted the API');
    return JSON.parse(succeeds ? result.stdout : result.stderr);
  }
  return { directory, run };
}

async function privateFile(file) {
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
}

test('Play CLI generates, preserves, and exports a usable upload key across processes', async (t) => {
  const { directory, run } = await setup(t);
  const application = ['--application-id', 'com.example.storeauthe2e'];
  await run(['android', 'play', 'generate-keystore', ...application]);
  const secretPath = path.join(directory, '.lim/secrets/androidSigningKey__com.example.storeauthe2e.json');
  const before = await readFile(secretPath);
  await run(['android', 'play', 'generate-keystore', ...application], false);
  assert.deepEqual(await readFile(secretPath), before);
  await privateFile(secretPath);
  const output = path.join(directory, 'upload.p12');
  const credentials = path.join(directory, 'credentials.json');
  const args = [
    'android',
    'play',
    'export-keystore',
    ...application,
    '--output',
    output,
    '--credentials-output',
    credentials,
  ];
  await writeFile(credentials, 'existing');
  await run(args, false);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(await readFile(credentials, 'utf8'), 'existing');
  await rm(credentials);
  const response = await run(args);
  const { keystorePassword, keyAlias } = JSON.parse(await readFile(credentials, 'utf8'));
  assert.ok(!JSON.stringify(response).includes(keystorePassword));
  const p12 = forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer((await readFile(output)).toString('binary')),
    keystorePassword,
  );
  const bags = p12.getBags({ friendlyName: keyAlias }).friendlyName;
  assert.ok(bags.some((bag) => bag.key));
  assert.ok(bags.some((bag) => bag.cert));
  await privateFile(output);
  await privateFile(credentials);
});

test('Apple CLI generates a matching key/CSR and exports a usable certificate P12', async (t) => {
  const { directory, run } = await setup(t);
  const key = path.join(directory, 'signing.der');
  const csrPath = path.join(directory, 'request.pem');
  const args = [
    'ios',
    'apple',
    'generate-signing-key',
    '--common-name',
    'CLI E2E',
    '--private-key-output',
    key,
    '--csr-output',
    csrPath,
  ];
  await writeFile(csrPath, 'existing');
  await run(args, false);
  await assert.rejects(stat(key), { code: 'ENOENT' });
  assert.equal(await readFile(csrPath, 'utf8'), 'existing');
  await rm(csrPath);
  await run(args);
  const csr = forge.pki.certificationRequestFromPem(await readFile(csrPath, 'utf8'));
  assert.ok(csr.verify());
  const privateKey = forge.pki.privateKeyFromAsn1(
    forge.asn1.fromDer((await readFile(key)).toString('binary')),
  );
  assert.equal(csr.publicKey.n.toString(16), privateKey.n.toString(16));
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = csr.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(Date.now() + 86400000);
  certificate.setSubject(csr.subject.attributes);
  certificate.setIssuer(csr.subject.attributes);
  certificate.sign(privateKey, forge.md.sha256.create());
  const certificatePath = path.join(directory, 'certificate.der');
  await writeFile(
    certificatePath,
    Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(), 'binary'),
  );
  const password = path.join(directory, 'password');
  await writeFile(password, 'e2e-password\n');
  const output = path.join(directory, 'signing.p12');
  await run([
    'ios',
    'apple',
    'export-certificate-p12',
    '--private-key',
    key,
    '--certificate',
    certificatePath,
    '--password-file',
    password,
    '--output',
    output,
  ]);
  const p12 = forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer((await readFile(output)).toString('binary')),
    'e2e-password',
  );
  assert.ok(p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag].length);
  await privateFile(key);
  await privateFile(csrPath);
  await privateFile(output);
});

test('Apple upload without a saved login fails before any API request', async (t) => {
  const { run } = await setup(t);
  for (const flags of [[], ['--team-id', 'MISSING']]) {
    const result = await run(['xcode', 'build', '--upload-to-appstore', ...flags], false);
    assert.match(JSON.stringify(result), /Run lim ios apple auth first/);
  }
});
