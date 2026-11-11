#!/usr/bin/env node
// Local transport benchmark. The server binary runs TestRBETunnelBenchmarkServer
// from limrun/pkg/limbuild against the workload server in this file.
// Usage: node scripts/benchmark-multiplexed-tunnel.cjs /tmp/lim-mux-benchmark-server results.json
const net = require('node:net');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = Buffer.alloc(64 * 1024, 0x61);
const childMode = process.env.MUX_BENCH_CHILD;

function metrics() {
  global.gc?.();
  let initialRss = process.memoryUsage().rss;
  let initialCpu = process.cpuUsage();
  let peakRss = initialRss;
  let peakSocketQueue = 0;
  let peakWsQueue = 0;
  let totalEnqueued = 0;
  const sockets = new Set();
  const websockets = new Set();
  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    for (const s of sockets) peakSocketQueue = Math.max(peakSocketQueue, s.writableLength);
    for (const ws of websockets) peakWsQueue = Math.max(peakWsQueue, ws.bufferedAmount);
  };
  const timer = setInterval(sample, 10);
  return {
    sockets,
    websockets,
    reset() {
      global.gc?.();
      initialRss = process.memoryUsage().rss;
      initialCpu = process.cpuUsage();
      peakRss = initialRss;
      peakSocketQueue = 0;
      peakWsQueue = 0;
      totalEnqueued = 0;
    },
    wrote(n) {
      totalEnqueued += n;
    },
    snapshot() {
      sample();
      const cpu = process.cpuUsage(initialCpu);
      return {
        initialRssMiB: initialRss / MiB,
        peakRssMiB: peakRss / MiB,
        rssIncreaseMiB: (peakRss - initialRss) / MiB,
        cpuMs: (cpu.user + cpu.system) / 1000,
        peakSocketQueueMiB: peakSocketQueue / MiB,
        peakWsQueueMiB: peakWsQueue / MiB,
        totalEnqueuedMiB: totalEnqueued / MiB,
      };
    },
    close() {
      clearInterval(timer);
    },
  };
}

async function runBackend() {
  const stats = metrics();
  const server = net.createServer((socket) => {
    stats.sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.on('close', () => stats.sockets.delete(socket));
    let header = Buffer.alloc(0),
      uploadRemaining = 0;
    async function send(n, rate = 0) {
      const started = performance.now();
      let sent = 0;
      while (n > 0 && !socket.destroyed) {
        const data = chunk.subarray(0, Math.min(n, chunk.length));
        n -= data.length;
        stats.wrote(data.length);
        if (!socket.write(data)) await once(socket, 'drain');
        sent += data.length;
        if (rate && sent % MiB === 0) {
          const delay = started + (sent / rate) * 1000 - performance.now();
          if (delay > 0) await sleep(delay);
        }
      }
    }
    socket.on('data', (data) => {
      if (uploadRemaining) {
        uploadRemaining -= data.length;
        if (uploadRemaining === 0) {
          socket.write(Buffer.from([1]));
          socket.resume();
        }
        return;
      }
      header = Buffer.concat([header, data]);
      if (header.length < 5) return;
      const op = header[0],
        size = header.readUInt32BE(1),
        remainder = header.subarray(5);
      header = Buffer.alloc(0);
      if (op === 1 || op === 2 || op === 5) {
        socket.pause();
        send(size, op === 5 ? 100 * MiB : 0)
          .then(() => socket.resume())
          .catch(() => {});
      } else if (op === 3) {
        uploadRemaining = size - remainder.length;
        if (!uploadRemaining) socket.write(Buffer.from([1]));
      } else if (op === 4) {
        socket.pause(); // Deliberately stalled consumer, closed by the parent.
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.send({ ready: true, port: server.address().port });
  process.on('message', (msg) => {
    if (msg === 'stats') process.send({ stats: stats.snapshot() });
    if (msg === 'reset') {
      stats.reset();
      process.send({ reset: true });
    }
    if (msg === 'stop') {
      stats.close();
      for (const socket of stats.sockets) socket.destroy();
      server.close(() => process.exit(0));
    }
  });
}

async function runForwarder() {
  // Instrument only the benchmark child; production source and compiled files stay unchanged.
  const stats = metrics();
  const originalCreate = net.createServer;
  net.createServer = (...args) => {
    const server = originalCreate(...args);
    server.on('connection', (socket) => {
      stats.sockets.add(socket);
      socket.on('close', () => stats.sockets.delete(socket));
    });
    return server;
  };
  const { WebSocket } = require('ws');
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (...args) {
    stats.websockets.add(this);
    return send.apply(this, args);
  };
  const source = require.resolve('../dist/tunnel.js');
  let transport;
  if (process.env.MUX_BENCH_VARIANT === 'baseline') {
    const compiled = new Module(source, module);
    compiled.filename = source;
    compiled.paths = Module._nodeModulePaths(path.dirname(source));
    compiled._compile(fs.readFileSync(process.env.MUX_BENCH_BASELINE, 'utf8'), source);
    transport = compiled.exports;
  } else transport = require(source);
  const tunnel = await transport.startTcpTunnel(
    process.env.MUX_BENCH_URL,
    'benchmark-token',
    '127.0.0.1',
    0,
    { mode: 'multiplexed', logLevel: 'none', maxReconnectAttempts: 0 },
  );
  process.send({ ready: true, port: tunnel.address.port });
  process.on('message', (msg) => {
    if (msg === 'stats') process.send({ stats: stats.snapshot() });
    if (msg === 'reset') {
      stats.reset();
      process.send({ reset: true });
    }
    if (msg === 'stop') {
      stats.close();
      tunnel.close();
      setTimeout(() => process.exit(0), 20);
    }
  });
}

// Delay bytes in both directions without serializing one timer per chunk. This
// models propagation delay, not packet loss, bandwidth limits, or TCP congestion.
async function runLatencyProxy() {
  const peers = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(process.env.MUX_BENCH_RELAY_PORT), '127.0.0.1');
    for (const socket of [client, upstream]) {
      peers.add(socket);
      socket.setNoDelay(true);
      socket.on('error', () => {});
      socket.on('close', () => {
        peers.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    function delay(source, destination) {
      const queue = [];
      let queued = 0,
        timer,
        blocked = false,
        nextSendAt = 0;
      function flush() {
        clearTimeout(timer);
        timer = undefined;
        while (queue.length && !blocked && !destination.destroyed) {
          const wait = queue[0].at - performance.now();
          if (wait > 0) {
            timer = setTimeout(flush, wait);
            return;
          }
          const { data } = queue.shift();
          queued -= data.length;
          blocked = !destination.write(data);
        }
        if (queued < 16 * MiB && !source.destroyed) source.resume();
      }
      source.on('data', (data) => {
        const at = Math.max(nextSendAt, performance.now() + Number(process.env.MUX_BENCH_RTT_MS) / 2);
        const rate = Number(process.env.MUX_BENCH_LINK_MIBPS || 0) * MiB;
        nextSendAt = at + (rate ? (data.length / rate) * 1000 : 0);
        queue.push({ data, at });
        queued += data.length;
        if (queued >= 32 * MiB) source.pause();
        if (!timer && !blocked) flush();
      });
      destination.on('drain', () => {
        blocked = false;
        flush();
      });
      destination.on('close', () => {
        clearTimeout(timer);
        queue.length = 0;
      });
    }
    delay(client, upstream);
    delay(upstream, client);
  });
  server.listen(0, '127.0.0.1', () => process.send({ ready: true, port: server.address().port }));
  process.on('message', (msg) => {
    if (msg === 'stop') {
      for (const socket of peers) socket.destroy();
      server.close(() => process.exit(0));
    }
  });
}

function child(mode, extra = {}) {
  const proc = fork(__filename, [], {
    execArgv: ['--expose-gc'],
    env: { ...process.env, MUX_BENCH_CHILD: mode, ...extra },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ready = new Promise((resolve, reject) => {
    proc.on('message', (msg) => {
      if (msg.ready) resolve(msg);
    });
    proc.once('exit', (code) => reject(new Error(`${mode} exited before ready: ${code}`)));
    proc.once('error', reject);
  });
  return { proc, ready };
}
async function resetStats(proc) {
  const response = once(proc, 'message');
  proc.send('reset');
  await response;
}
async function getStats(proc) {
  const response = once(proc, 'message');
  proc.send('stats');
  return (await response)[0].stats;
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exit = once(proc, 'exit');
  proc.send('stop');
  await exit;
}
async function connect(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setNoDelay(true);
  await once(socket, 'connect');
  return socket;
}
function header(op, n) {
  const buf = Buffer.alloc(5);
  buf[0] = op;
  buf.writeUInt32BE(n, 1);
  return buf;
}
function read(socket, bytes, timeout = 20000) {
  return new Promise((resolve, reject) => {
    let remaining = bytes;
    const start = performance.now();
    const timer = setTimeout(
      () => finish(new Error(`read timed out with ${remaining}/${bytes} bytes remaining`)),
      timeout,
    );
    const data = (chunk) => {
      remaining -= chunk.length;
      if (remaining === 0) finish();
      else if (remaining < 0) finish(new Error('extra response bytes'));
    };
    const close = () => finish(new Error(`closed with ${remaining} bytes remaining`));
    const error = (err) => finish(err);
    function finish(err) {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('close', close);
      socket.off('error', error);
      if (err) reject(err);
      else resolve(performance.now() - start);
    }
    socket.on('data', data);
    socket.once('close', close);
    socket.once('error', error);
    socket.resume();
  });
}
async function download(socket, size, op = 2) {
  const response = read(socket, size);
  socket.write(header(op, size));
  return response;
}
async function upload(socket, size) {
  const start = performance.now();
  const response = read(socket, 1);
  socket.write(header(3, size));
  while (size > 0) {
    const data = chunk.subarray(0, Math.min(size, chunk.length));
    size -= data.length;
    if (!socket.write(data)) await once(socket, 'drain');
  }
  await response;
  return performance.now() - start;
}
const percentile = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
function latencyStats(xs) {
  return {
    count: xs.length,
    medianMs: percentile(xs, 0.5),
    p95Ms: percentile(xs, 0.95),
    p99Ms: percentile(xs, 0.99),
  };
}
async function ping(socket, timeout = 2000) {
  const response = read(socket, 1024, timeout);
  socket.write(header(1, 1024));
  return response;
}
async function scenario(name, port) {
  const a = await connect(port);
  a.on('error', () => {});
  let b;
  try {
    // Warm up the forwarding connection before timing workloads.
    for (let i = 0; i < (process.env.MUX_BENCH_RTT_MS ? 5 : 50); i++) await ping(a);
    if (name === 'latency') {
      const samples = [];
      for (let i = 0; i < 2000; i++) samples.push(await ping(a));
      return latencyStats(samples);
    }
    if (name === 'download' || name === 'upload') {
      const size = Number(process.env.MUX_BENCH_MIB || 256) * MiB;
      const elapsedMs = await (name === 'download' ? download(a, size) : upload(a, size));
      return { bytes: size, elapsedMs, MiBps: size / MiB / (elapsedMs / 1000) };
    }
    if (name === 'mixed' || name === 'mixed-100mibps') {
      b = await connect(port);
      b.on('error', () => {});
      let stopped = false,
        bytes = 0;
      const started = performance.now();
      const bulk = (async () => {
        while (!stopped) {
          await download(b, 16 * MiB, name === 'mixed-100mibps' ? 5 : 2);
          bytes += 16 * MiB;
        }
      })();
      const samples = [];
      try {
        for (let i = 0; i < 250; i++) {
          samples.push(await ping(a));
          await sleep(5);
        }
      } finally {
        stopped = true;
        await bulk;
      }
      return { ...latencyStats(samples), bulkMiBps: bytes / MiB / ((performance.now() - started) / 1000) };
    }
    if (name === 'stalled-download') {
      b = await connect(port);
      b.on('error', () => {});
      b.pause();
      b.write(header(2, 128 * MiB));
      await sleep(1500);
      const samples = [];
      for (let i = 0; i < 30; i++) samples.push(await ping(a));
      return { ...latencyStats(samples), requestedMiB: 128 };
    }
    if (name === 'stalled-upload') {
      b = await connect(port);
      b.on('error', () => {});
      b.write(header(4, 128 * MiB));
      let remaining = 128 * MiB,
        stopped = false,
        accepted = 0;
      // Bound generation to 128 MiB and stop on close, including while waiting for drain.
      const producer = (async () => {
        try {
          while (remaining && !stopped) {
            const n = Math.min(remaining, chunk.length);
            remaining -= n;
            accepted += n;
            if (!b.write(chunk.subarray(0, n)))
              await new Promise((resolve, reject) => {
                const cleanup = () => {
                  b.off('drain', drained);
                  b.off('close', closed);
                };
                const drained = () => {
                  cleanup();
                  resolve();
                };
                const closed = () => {
                  cleanup();
                  reject(new Error('closed'));
                };
                b.once('drain', drained);
                b.once('close', closed);
              });
          }
        } catch {}
      })();
      await sleep(1000);
      let probe;
      try {
        probe = { latencyMs: await ping(a, 1500), timedOut: false };
      } catch (err) {
        probe = { timedOut: true, error: err.message };
      }
      stopped = true;
      // Leave the sockets alive until statistics have been sampled by the parent.
      b.destroy();
      await producer;
      return { ...probe, acceptedMiB: accepted / MiB };
    }
    throw new Error(name);
  } finally {
    a.destroy();
    b?.destroy();
  }
}

async function main() {
  const [binary, resultFile] = process.argv.slice(2);
  if (!binary || !resultFile) throw new Error('pass the Go benchmark server binary and a JSON output path');
  const baseline = path.join(require('node:os').tmpdir(), 'lim-mux-baseline-runtime.js');
  const baselineSource = require('node:child_process').execFileSync(
    'git',
    ['show', 'd84fdf7d:src/tunnel.ts'],
    { encoding: 'utf8' },
  );
  const ts = require('typescript');
  fs.writeFileSync(
    baseline,
    ts.transpileModule(baselineSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText,
  );
  process.env.MUX_BENCH_BASELINE = baseline;
  const server = spawn(
    binary,
    process.env.MUX_BENCH_SERVER_KIND === 'swift' ?
      []
    : ['-test.run=^TestRBETunnelBenchmarkServer$', '-test.timeout=15m'],
    { env: { ...process.env, LIM_MUX_BENCH: '1' }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const serverUrl = await new Promise((resolve, reject) => {
    let text = '';
    server.stdout.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/MUX_BENCH_URL=(\S+)/);
      if (match) resolve(match[1]);
    });
    server.once('exit', (code) => reject(new Error(`Go server exited ${code}`)));
  });
  let latencyProxy;
  let relayUrl = serverUrl;
  if (Number(process.env.MUX_BENCH_RTT_MS)) {
    latencyProxy = child('latency-proxy', { MUX_BENCH_RELAY_PORT: new URL(serverUrl).port });
    relayUrl = `ws://127.0.0.1:${(await latencyProxy.ready).port}`;
  }
  const results = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sdkCommit: require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
      .trim(),
    description:
      'Loopback without TLS or network delay. baseline is SDK d84fdf7d; mux is the working-tree SDK. Both use the same production relay binary, negotiating v2 only for the new client.',
    serverKind: process.env.MUX_BENCH_SERVER_KIND || 'go',
    simulatedRttMs: Number(process.env.MUX_BENCH_RTT_MS || 0),
    simulatedLinkMiBps: Number(process.env.MUX_BENCH_LINK_MIBPS || 0),
    cases: [],
  };
  try {
    const trials = Number(process.env.MUX_BENCH_TRIALS || 3);
    const names = (
      process.env.MUX_BENCH_CASES || 'latency,download,upload,mixed,stalled-download,stalled-upload'
    ).split(',');
    for (let trial = 0; trial < trials; trial++)
      for (const name of names) {
        const variants = (process.env.MUX_BENCH_VARIANTS || 'direct,baseline,mux').split(',');
        if (trial % 2) variants.reverse();
        for (const variant of variants) {
          const backend = child('backend');
          let forward;
          try {
            const target = (await backend.ready).port;
            let port = target;
            if (variant !== 'direct') {
              forward = child('forwarder', {
                MUX_BENCH_URL: `${relayUrl}/?target=127.0.0.1:${target}`,
                MUX_BENCH_VARIANT: variant,
              });
              port = (await forward.ready).port;
            }
            await resetStats(backend.proc);
            if (forward) await resetStats(forward.proc);
            const result = await scenario(name, port);
            const record = {
              trial: trial + 1,
              name,
              variant,
              ...result,
              backend: await getStats(backend.proc),
              forwarder: forward ? await getStats(forward.proc) : undefined,
            };
            results.cases.push(record);
            fs.writeFileSync(resultFile, JSON.stringify(results, null, 2) + '\n');
            console.error(
              JSON.stringify({ trial: trial + 1, name, variant, ...result, forwarder: record.forwarder }),
            );
          } finally {
            await stop(forward?.proc);
            await stop(backend.proc);
          }
        }
      }
  } finally {
    await stop(latencyProxy?.proc);
    server.kill('SIGKILL');
  }
}
(childMode === 'backend' ? runBackend()
: childMode === 'forwarder' ? runForwarder()
: childMode === 'latency-proxy' ? runLatencyProxy()
: main()
).catch((err) => {
  console.error(err);
  process.exit(1);
});
