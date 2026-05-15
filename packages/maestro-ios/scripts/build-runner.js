'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const extract = require('extract-zip');

const gradleVersion = '9.5.1';
const gradleChecksum = 'bafc141b619ad6350fd975fc903156dd5c151998cc8b058e8c1044ab5f7b031f';
const downloadUrl = `https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip`;
const root = path.resolve(__dirname, '..');
const cacheDir = path.join(root, '.gradle');
const lockPath = path.join(cacheDir, 'build-runner.lock');
const zipPath = path.join(cacheDir, `gradle-${gradleVersion}-bin.zip`);
const gradleDir = path.join(cacheDir, `gradle-${gradleVersion}`);
const gradleBin = path.join(gradleDir, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  fs.mkdirSync(cacheDir, { recursive: true });
  const releaseLock = await acquireBuildLock();
  try {
    await buildRunner();
  } finally {
    releaseLock();
  }
}

async function buildRunner() {
  if (!fs.existsSync(gradleBin)) {
    // Gradle is a build-time concern only; customers run the packaged JAR with java.
    await downloadGradle();
    await extract(zipPath, { dir: cacheDir });
  }

  const result = spawnSync(gradleBin, ['-p', 'runner', 'clean', 'shadowJar'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Gradle runner build failed with exit code ${result.status}`);
  }
}

async function acquireBuildLock() {
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      // The example and package can both build this local package; serialize writes to the JAR.
      clearStaleBuildLock();
      if (Date.now() - startedAt > 10 * 60 * 1000) {
        throw new Error(`Timed out waiting for runner build lock: ${lockPath}`);
      }
      await sleep(500);
    }
  }
}

async function downloadGradle() {
  if (!fs.existsSync(zipPath)) {
    console.log(`Downloading Gradle ${gradleVersion} for runner build...`);
    await download(downloadUrl, zipPath);
  }

  const checksum = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  if (checksum !== gradleChecksum) {
    fs.rmSync(zipPath, { force: true });
    throw new Error(`Gradle distribution checksum mismatch for ${zipPath}`);
  }
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      response.on('error', reject);
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

function isFileExistsError(error) {
  return typeof error === 'object' && error !== null && error.code === 'EEXIST';
}

function clearStaleBuildLock() {
  try {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs > 10 * 60 * 1000) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Another process may have released the lock between attempts.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
