import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Credentials are read from an untracked CLI result and never written to the report.
const instance = JSON.parse(await readFile(process.env.VALIDATION_INSTANCE, 'utf8'));
const output = resolve(process.env.VALIDATION_OUTPUT || 'validation-output');
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  server: { host: '127.0.0.1', port: 0, watch: null },
});
await server.listen();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.addInitScript(() => {
  window.peers = [];
  const Original = RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args) {
      super(...args);
      window.peers.push(this);
    }
  };
});
const report = [];
try {
  await page.goto(server.resolvedUrls.local[0] + 'validation/');
  await page.waitForFunction(() => window.validation);
  await page.evaluate((value) => window.validation.stream(value), {
    url: instance.status.endpointWebSocketUrl,
    token: instance.status.token,
  });
  for (const orientation of ['Portrait', 'Landscape', 'Portrait']) {
    execFileSync('lim', [
      'ios',
      'perform',
      '--id',
      instance.metadata.id,
      '--action',
      `type=setOrientation,orientation=${orientation}`,
      '--json',
    ]);
    let stats = [];
    let previous;
    let stable = 0;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && stable < 3) {
      await page.waitForTimeout(500);
      stats = await page.evaluate(async (landscape) => {
        const records = [];
        for (const peer of window.peers) {
          if (peer.connectionState !== 'connected') continue;
          const stats = await peer.getStats();
          for (const r of stats.values())
            if (
              r.type === 'inbound-rtp' &&
              r.kind === 'video' &&
              r.framesDecoded > 0 &&
              r.frameWidth > r.frameHeight === landscape
            ) {
              records.push({
                width: r.frameWidth,
                height: r.frameHeight,
                framesDecoded: r.framesDecoded,
                codec: stats.get(r.codecId)?.mimeType,
              });
            }
        }
        return records;
      }, orientation === 'Landscape');
      const dimensions = JSON.stringify(stats.map(({ width, height }) => [width, height]));
      stable = stats.length && dimensions === previous ? stable + 1 : 0;
      previous = dimensions;
    }
    if (stable < 3) throw new Error(`No stable ${orientation} video received`);
    report.push({ orientation, stats });
    await page.screenshot({ path: resolve(output, `stream-${report.length}-${orientation}.png`) });
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(resolve(output, 'stream.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (
  !report.every((r) =>
    r.stats.some(
      (s) =>
        s.width > 0 &&
        Math.abs(Math.max(s.width, s.height) / Math.min(s.width, s.height) / (874 / 402) - 1) < 0.0005,
    ),
  )
)
  process.exitCode = 1;
