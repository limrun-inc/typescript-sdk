# Multiplexed forwarding measurements

Measured locally on macOS arm64 with Node 26.5.0. Each value below is the median
of three trials, alternating old/new order between trials. Both clients use the
same production relay binary; only the new client negotiates version 2. The old
transport comes from `c6529835`, byte-identical to `d84fdf7d:src/tunnel.ts`, which
the harness uses as its durable baseline. The new implementation is in this PR;
the server implementation is in limrun PR 2141.

These measure the transport with real TCP sockets and the production Go RBE and
Swift TCP/UNIX relay code. They do not run Bazel, Appium, Safari, a simulator,
production ingress, or TLS. Memory and CPU figures cover the SDK forwarder process,
not the relay or workload. RSS is sampled every 10 ms and includes runtime heap
and allocator effects; it is not a measure of queued payload alone.

## Loopback

Bulk cases transfer 256 MiB. Mixed traffic sends 250 small requests alongside a
download paced at 100 MiB/s. The stalled cases offer 128 MiB to a newly opened
connection whose consumer stops reading.

| Measurement                                 |    Go old | Go v2 | Swift old | Swift v2 |
| ------------------------------------------- | --------: | ----: | --------: | -------: |
| Small request median, ms                    |     0.071 | 0.081 |     0.080 |    0.073 |
| Bulk download, MiB/s                        |     2,760 | 2,865 |     3,195 |    3,106 |
| Bulk upload, MiB/s                          |       727 |   722 |       813 |      796 |
| Mixed small-request p95, ms                 |     1.080 | 0.927 |     0.975 |    0.850 |
| Mixed forwarder CPU, ms                     |       280 |   505 |       372 |      528 |
| Stalled-download RSS increase, MiB          |       222 |    12 |       200 |       12 |
| Stalled-upload RSS increase, MiB            |       220 |     9 |        95 |        9 |
| Unrelated request during stalled upload, ms | timed out | 1.047 |     0.929 |    0.798 |
| Stalled upload accepted locally, MiB        |       128 |  4.50 |       128 |     3.44 |

Go's old relay timed out the unrelated request at 1,500 ms in all three trials.
Swift's old relay kept the other stream usable but accepted the entire blocked
upload. Version 2 limits queued data in both implementations. A stream that stalls
after sustained traffic can have a larger window, up to 16 MiB; kernel socket
buffers are additional.

Bulk throughput stays within about 4% of the old implementation in these runs.
Fair scheduling improves mixed-request p95 by 13–14%, at a CPU cost of about
42–80% for that mixed workload. This is primarily an isolation and memory change,
not a general CPU or throughput improvement.

## Simulated network latency

The `*-50ms.json` runs transfer 64 MiB with 50 ms round-trip propagation delay and
a 100 MiB/s link rate. A byte-delay proxy models both directions, with pipelining;
it does not model packet loss, congestion control, or production network jitter.
The new connection starts with 1 MiB credit and grows as its consumer drains data.

Old transport throughput is about 86–89 MiB/s; version 2 is about 78 MiB/s in both
directions and both relay implementations. The roughly 10–13% difference includes
the initial window growth on a fresh connection. A fixed 1 MiB window was rejected
after an earlier unthrottled 50 ms experiment capped throughput near 10 MiB/s.
Window growth reached 111–136 MiB/s in that same exploratory experiment.

## Reproducing

Build the SDK with `yarn build`. Build a relay fixture as described in the server's
`pkg/muxtunnel/protocol.md`, then run:

```sh
MUX_BENCH_VARIANTS=baseline,mux \
MUX_BENCH_CASES=latency,download,upload,mixed-100mibps,stalled-download,stalled-upload \
node scripts/benchmark-multiplexed-tunnel.cjs /path/to/relay results.json
```

Set `MUX_BENCH_SERVER_KIND=swift` for the Swift fixture. For the simulated link,
also set `MUX_BENCH_RTT_MS=50 MUX_BENCH_LINK_MIBPS=100 MUX_BENCH_MIB=64` and use
`MUX_BENCH_CASES=download,upload`. The default is three trials. Run performance
measurements without concurrent builds or tests.

The `mux-v2-*.json` files contain the final comparisons above. The earlier
`mux-forward-*.json` files preserve the initial investigation of the old transport
against direct TCP and the disabled-debug-logging prototype. In those older files,
`mux` means the original transport, not version 2.
