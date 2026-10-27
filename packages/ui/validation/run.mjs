import { chromium } from 'playwright';
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.VALIDATION_OUTPUT || 'validation-output');
const model = process.env.DUO_MODEL && resolve(process.env.DUO_MODEL);
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: false,
  root,
  server: {
    host: '127.0.0.1',
    port: 0,
    watch: null,
    fs: { allow: [root, ...(model ? [dirname(model)] : [])] },
  },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: [
    `--use-angle=${process.env.VALIDATION_ANGLE || 'swiftshader'}`,
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const report = { hinge: [], sizing: [], motion: [], errors: [] };
const phase = process.env.VALIDATION_PHASE;
const orientations = (process.env.VALIDATION_ORIENTATIONS || 'portrait,landscape-left').split(',');
const appearances = [{ name: 'procedural' }, ...(model ? [{ name: 'glb', modelUrl: '/@fs/' + model }] : [])];
function imageBounds(bytes) {
  const png = PNG.sync.read(bytes);
  let minX = png.width,
    maxX = -1,
    minY = png.height,
    maxY = -1;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] > 220 && png.data[i + 1] < 30 && png.data[i + 2] > 220) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto(base + 'validation/');
  await page.waitForFunction(() => window.validation);
  for (const appearance of appearances) {
    if (!phase || phase === 'hinge')
      for (const dpr of [1, 1.5, 2, 3])
        for (const [width, height] of [
          [640, 480],
          [800, 600],
          [1001, 713],
          [1280, 800],
          [393, 852],
        ]) {
          for (const [yaw, pitch] of [
            [0.2, 0],
            [0.4, 0.1],
            [-0.2, 0],
            [-0.4, 0.1],
          ]) {
            const test = { ...appearance, width, height, dpr, yaw, pitch, angle: 180 };
            const { screenshot, ...result } = await page.evaluate(
              (test) => window.validation.hinge(test),
              test,
            );
            report.hinge.push({ ...test, ...result });
            if (
              result.darkPixels &&
              !report.hinge.slice(0, -1).some((r) => r.name === appearance.name && r.darkPixels)
            ) {
              await writeFile(
                resolve(output, `hinge-${appearance.name}.png`),
                Buffer.from(screenshot.split(',')[1], 'base64'),
              );
            }
          }
        }
    if (phase && phase !== 'sizing') continue;
    for (const [width, height] of [
      [800, 600],
      [1001, 713],
      [393, 852],
    ])
      for (const angle of [0, 180])
        for (const orientation of orientations) {
          await page.setViewportSize({ width, height });
          await page.evaluate((test) => window.validation.mount(test), {
            angle,
            orientation,
            modelUrl: appearance.modelUrl,
          });
          await page.locator('.rc-duo-flat-screen video').waitFor();
          await page.waitForFunction(
            () => document.querySelector('.rc-duo-flat-screen video')?.readyState >= 2,
          );
          await page.waitForTimeout(100);
          const flat = await page.screenshot();
          await page.getByRole('button', { name: '3D', exact: true }).click();
          await page.locator('.rc-duo-stage canvas').waitFor();
          // Camera fitting and cover yaw use damped animation; sample only after settlement.
          let three;
          let previous;
          let stable = 0;
          for (let sample = 0; sample < 30 && stable < 3; sample++) {
            await page.waitForTimeout(500);
            three = await page.screenshot();
            const bounds = JSON.stringify(imageBounds(three));
            stable = bounds === previous ? stable + 1 : 0;
            previous = bounds;
          }
          if (stable < 3) throw new Error('3D camera did not settle');
          const a = imageBounds(flat),
            b = imageBounds(three);
          const error = Math.max(
            Math.abs(a.width - b.width),
            Math.abs(a.height - b.height),
            Math.abs(a.x - b.x),
            Math.abs(a.y - b.y),
          );
          const test = {
            appearance: appearance.name,
            width,
            height,
            angle,
            orientation,
            flat: a,
            three: b,
            error,
          };
          report.sizing.push(test);
          const name = `size-${appearance.name}-${width}-${height}-${angle}-${orientation}`;
          await writeFile(resolve(output, `${name}-2d.png`), flat);
          await writeFile(resolve(output, `${name}-3d.png`), three);
        }
  }
  if (!phase || phase === 'motion') {
    await page.setViewportSize({ width: 800, height: 600 });
    for (const orientation of orientations) {
      await page.evaluate((orientation) => window.validation.mount({ angle: 180, orientation }), orientation);
      await page.waitForFunction(() => document.querySelector('.rc-duo-flat-screen video')?.readyState >= 2);
      for (const action of ['Fold', 'Unfold']) {
        await page.getByRole('button', { name: action, exact: true }).click();
        const canvas = page.locator('.rc-duo-fold-canvas');
        await canvas.waitFor({ state: 'visible' });
        await page.screenshot({ path: resolve(output, `motion-${orientation}-${action}.png`) });
        await canvas.waitFor({ state: 'detached' });
        await page.waitForFunction(
          () => document.querySelector('.rc-duo-flat-screen video')?.readyState >= 2,
        );
        const bounds = imageBounds(await page.screenshot());
        if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Display missing after fold');
        report.motion.push({ orientation, action, bounds });
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
const hingeFailures = report.hinge.filter((r) => r.darkPixels > 0).length;
const sizingFailures = report.sizing.filter(
  (r) => r.error > 2 || r.flat.width <= 0 || r.three.width <= 0,
).length;
console.log(
  JSON.stringify(
    {
      hingeCases: report.hinge.length,
      hingeFailures,
      sizingCases: report.sizing.length,
      sizingFailures,
      motionCases: report.motion.length,
      errors: report.errors,
    },
    null,
    2,
  ),
);
process.exitCode = hingeFailures || sizingFailures || report.errors.length ? 1 : 0;
