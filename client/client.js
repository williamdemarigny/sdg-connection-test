#!/usr/bin/env node
/*
 * SDG Connection Test — client.
 *
 * WHAT THIS TOOL DOES
 *   Sends small test packets to an SDG-operated diagnostic server on the
 *   TCP and UDP ports that Space Engineers, Torch, and Steam use, and
 *   reports whether the packets got through, how long they took, and how
 *   many were lost. It exists to prove or disprove the hypothesis that a
 *   specific ISP is blocking or throttling the traffic your game needs.
 *
 * WHAT THIS TOOL DOES NOT DO
 *   - It does NOT read any game files, save files, or Steam files.
 *   - It does NOT read or transmit your username, computer name, env vars,
 *     installed software, or any other system information.
 *   - It does NOT open any network connection except to the --host you
 *     pass on the command line (and optionally the --real-server host).
 *   - It does NOT modify your firewall, registry, or any system setting.
 *   - It does NOT auto-update itself or download any additional code.
 *   - It writes one file and only if you pass --json: a local report file
 *     in the current directory. Nothing is uploaded anywhere.
 *
 * HOW TO AUDIT IT
 *   1. This file is the only code that runs. It has zero runtime
 *      dependencies — it uses only Node.js built-ins (net, dgram, crypto,
 *      dns/promises, perf_hooks, fs/promises, process, util).
 *   2. Two sibling files are also loaded: ../shared/ports.js (the port
 *      list) and ../shared/protocol.js (the binary packet format). Both
 *      are small and fully commented. Read them.
 *   3. Every byte sent on the wire is documented in ../docs/PROTOCOL.md
 *      and cross-referenced with a Wireshark capture in
 *      ../docs/TRANSPARENCY.md. The session nonce printed at startup
 *      appears in bytes 8..15 of every outbound packet, so you can filter
 *      your Wireshark capture on that nonce and see exactly what the
 *      client sent.
 *   4. There are no eval()s, no dynamic requires, no network calls hidden
 *      behind abstractions. Search this file for 'require(', 'net.',
 *      'dgram.', 'fs.' — those are the only I/O points.
 *
 * LICENSE
 *   Provided as-is for diagnostic use by SDG customers. See top-level
 *   README.md.
 */

'use strict';

// ---- I/O surface: these are the ONLY Node built-ins used. ----
const net        = require('net');
const dgram      = require('dgram');
const dns        = require('dns/promises');
const crypto     = require('crypto');
const fs         = require('fs/promises');
const readline   = require('readline');
const { performance } = require('perf_hooks');

const { PORTS, GAME_SHAPE_PORT, A2S_PORT } = require('../shared/ports');
const protocol = require('../shared/protocol');

// ---- Tunables. Nothing here should need changing during normal runs. ----
const PROBE_TIMEOUT_MS   = 2000;
const LOSS_PACKET_COUNT  = 50;
const LOSS_INTERVAL_MS   = 100;      // 10 pps
const MTU_PAYLOAD_BYTES  = 1400;
const SUSTAINED_MS       = 10_000;   // game-shape test duration
const SUSTAINED_PPS      = 60;       // expected server rate; used only for
                                     // reporting, not for sending.
const TCP_CONNECT_TIMEOUT_MS = 3000;

// ---- CLI parsing: tiny, no deps, no getopt. ----
function parseArgs(argv) {
  const out = {
    host: null,
    ports: null,              // null = all
    sustained: true,
    a2s: true,
    realServer: null,         // 'host:port' or null
    json: null,
    yes: false,
    duration: SUSTAINED_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--host')        out.host = argv[++i];
    else if (a === '--ports')       out.ports = argv[++i].split(',').map(s => s.trim());
    else if (a === '--no-sustained') out.sustained = false;
    else if (a === '--no-a2s')      out.a2s = false;
    else if (a === '--real-server') out.realServer = argv[++i];
    else if (a === '--json')        out.json = argv[++i];
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--duration')    out.duration = Number(argv[++i]) * 1000;
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown argument: ${a}`); out.help = true; }
  }
  return out;
}

function printHelp() {
  console.log(`SDG Connection Test — client

Usage:
  node client.js --host <hostname-or-ip> [options]

Required:
  --host <addr>            SDG connection-test server to probe.

Options:
  --ports <p1,p2,...>      Only test these port numbers (comma-separated).
                           Matches both proto if both are in the table.
  --no-sustained           Skip the 10-second UDP 27016 game-shape test.
  --no-a2s                 Skip the Steam A2S_INFO query test.
  --real-server <h:p>      Also send an A2S_INFO to your real Torch server
                           (for side-by-side comparison). Example:
                             --real-server torch.example.com:27015
  --duration <seconds>     Override the sustained test duration (default 10).
  --json <file>            Write a full JSON report to <file>.
  --yes, -y                Skip the confirmation prompt.
  --help, -h               Show this help.

Example:
  node client.js --host test.sdgservers.example --json report.json

The tool will print exactly what it is about to do before doing it, and
wait for you to press 'y' unless you pass --yes.
`);
}

// ---- Small utils ----
function randomNonce() { return crypto.randomBytes(8); }
function nowNs()       { return process.hrtime.bigint(); }
function nowMs()       { return performance.now(); }
function toHex(buf)    { return buf.toString('hex'); }

function stats(samples) {
  if (samples.length === 0) return { n: 0, min: null, avg: null, p95: null, max: null, stddev: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  const avg = sum / samples.length;
  const variance = samples.reduce((a, b) => a + (b - avg) ** 2, 0) / samples.length;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    n: samples.length,
    min: sorted[0],
    avg: avg,
    p95: sorted[p95Idx],
    max: sorted[sorted.length - 1],
    stddev: Math.sqrt(variance),
  };
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}

// ---- DNS resolution. Only --host and optionally --real-server are ever resolved. ----
async function resolveHost(host) {
  // Accept a raw IP without a DNS call.
  if (net.isIP(host)) return host;
  const addrs = await dns.lookup(host, { family: 4 });
  return addrs.address;
}

// ================================================================
// UDP probes
// ================================================================

// Send one SDGT probe and wait up to PROBE_TIMEOUT_MS for the reply.
// Returns one of:
//   { ok: true,  rtt: <ms> }                    success
//   { ok: false, rtt: null, rateLimited: true } server told us we're rate limited
//   { ok: false, rtt: null, rateLimited: false } timeout (real loss)
function udpProbe({ host, port, nonce, sequence, payloadSize = protocol.HEADER_SIZE }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) {}
      resolve(result);
    };

    sock.on('error', () => finish({ ok: false, rtt: null, rateLimited: false }));
    sock.on('message', (msg) => {
      const decoded = protocol.decode(msg);
      if (!decoded) return;
      if (!decoded.nonce.equals(nonce)) return;
      if (decoded.type === protocol.TYPE.RATE_LIMITED) {
        finish({ ok: false, rtt: null, rateLimited: true });
        return;
      }
      if (decoded.type !== protocol.TYPE.REPLY) return;
      if (decoded.sequence !== sequence) return;
      finish({ ok: true, rtt: nowMs() - sendMs });
    });

    const pkt = protocol.encode({
      type: protocol.TYPE.PROBE,
      nonce, sequence,
      clientTsNs: nowNs(),
      totalSize: payloadSize,
    });
    const sendMs = nowMs();
    sock.send(pkt, port, host, (err) => {
      if (err) finish({ ok: false, rtt: null, rateLimited: false });
    });
    setTimeout(() => finish({ ok: false, rtt: null, rateLimited: false }), PROBE_TIMEOUT_MS);
  });
}

// Loss + latency test: send N probes at a fixed interval, count replies,
// compute latency stats. Also counts RATE_LIMITED server replies so the
// caller can distinguish "my ISP dropped these" from "the SDG server
// told me I'm over quota".
async function udpLossTest({ host, port, nonce }) {
  const rtts = [];
  let received = 0;
  let rateLimited = 0;
  const sock = dgram.createSocket('udp4');
  const pending = new Map();   // seq -> sendMs

  sock.on('message', (msg) => {
    const decoded = protocol.decode(msg);
    if (!decoded) return;
    if (!decoded.nonce.equals(nonce)) return;
    if (decoded.type === protocol.TYPE.RATE_LIMITED) { rateLimited++; return; }
    if (decoded.type !== protocol.TYPE.REPLY) return;
    const sent = pending.get(decoded.sequence);
    if (sent == null) return;
    pending.delete(decoded.sequence);
    rtts.push(nowMs() - sent);
    received++;
  });
  sock.on('error', () => {});

  for (let seq = 0; seq < LOSS_PACKET_COUNT; seq++) {
    const pkt = protocol.encode({
      type: protocol.TYPE.PROBE,
      nonce, sequence: seq,
      clientTsNs: nowNs(),
    });
    pending.set(seq, nowMs());
    sock.send(pkt, port, host, () => {});
    await new Promise((r) => setTimeout(r, LOSS_INTERVAL_MS));
  }
  await new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS));
  try { sock.close(); } catch (e) {}

  return {
    sent: LOSS_PACKET_COUNT,
    received,
    rateLimited,
    lossPct: (1 - received / LOSS_PACKET_COUNT) * 100,
    latency: stats(rtts),
  };
}

// ================================================================
// TCP probes
// ================================================================

function tcpProbe({ host, port, nonce, sequence }) {
  return new Promise((resolve) => {
    const start = nowMs();
    const sock = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) {}
      resolve(result);
    };

    sock.setTimeout(TCP_CONNECT_TIMEOUT_MS);
    sock.once('timeout', () => finish({ ok: false, rtt: null, reason: 'timeout' }));
    sock.once('error',   (err) => finish({ ok: false, rtt: null, reason: err.code || err.message }));

    sock.connect(port, host, () => {
      const connectMs = nowMs() - start;
      const frame = protocol.encode({
        type: protocol.TYPE.PROBE,
        nonce, sequence,
        clientTsNs: nowNs(),
      });
      const out = Buffer.alloc(2 + frame.length);
      out.writeUInt16LE(frame.length, 0);
      frame.copy(out, 2);

      const chunks = [];
      sock.on('data', (chunk) => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length < 2) return;
        const len = buf.readUInt16LE(0);
        if (buf.length < 2 + len) return;
        const reply = buf.subarray(2, 2 + len);
        const decoded = protocol.decode(reply);
        if (decoded && decoded.type === protocol.TYPE.REPLY && decoded.nonce.equals(nonce)) {
          finish({ ok: true, rtt: nowMs() - start, connectMs, reason: null });
        } else {
          finish({ ok: false, rtt: null, reason: 'bad-reply' });
        }
      });

      sock.write(out);
    });
  });
}

// ================================================================
// Steam A2S_INFO test (real Valve protocol)
// ================================================================

// Real Valve A2S_INFO query with the December 2020 challenge dance.
// Sequence (matches https://developer.valvesoftware.com/wiki/Server_queries ):
//
//   1. Client sends the 25-byte "Source Engine Query" request.
//   2. Server replies with S2C_CHALLENGE (9 bytes: FF FF FF FF 41 <u32>).
//   3. Client resends the request with the 4-byte challenge appended (29 bytes).
//   4. Server replies with A2S_INFO (header FF FF FF FF 49 followed by
//      packed fields).
//
// We parse step 4 into a small info object and return total RTT (step 1
// send to step 4 receive).
function a2sQuery({ host, port }) {
  return new Promise((resolve) => {
    const requestBase = Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0x54,
      0x53, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x20,
      0x45, 0x6e, 0x67, 0x69, 0x6e, 0x65, 0x20,
      0x51, 0x75, 0x65, 0x72, 0x79, 0x00,
    ]);
    const sock = dgram.createSocket('udp4');
    const start = nowMs();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (e) {}
      resolve(result);
    };

    sock.on('error', () => finish({ ok: false, rtt: null, info: null, reason: 'socket-error' }));

    sock.on('message', (msg) => {
      if (msg.length < 5) return;
      if (msg.readUInt32LE(0) !== 0xffffffff) return;

      // S2C_CHALLENGE — attach challenge and resend.
      if (msg[4] === 0x41) {
        if (msg.length < 9) return finish({ ok: false, rtt: null, info: null, reason: 'short-challenge' });
        const withChallenge = Buffer.alloc(requestBase.length + 4);
        requestBase.copy(withChallenge, 0);
        msg.copy(withChallenge, requestBase.length, 5, 9);
        sock.send(withChallenge, port, host, (err) => {
          if (err) finish({ ok: false, rtt: null, info: null, reason: err.code || 'send-error' });
        });
        return;
      }

      // A2S_INFO reply.
      if (msg[4] !== 0x49) return;
      let off = 5;
      const protocolByte = msg[off++];
      const readCStr = () => {
        const end = msg.indexOf(0, off);
        if (end < 0) return null;
        const s = msg.toString('utf8', off, end);
        off = end + 1;
        return s;
      };
      const name = readCStr();
      const map  = readCStr();
      const folder = readCStr();
      const game = readCStr();
      finish({
        ok: true,
        rtt: nowMs() - start,
        info: { protocol: protocolByte, name, map, folder, game },
        reason: null,
      });
    });

    sock.send(requestBase, port, host, (err) => {
      if (err) finish({ ok: false, rtt: null, info: null, reason: err.code || 'send-error' });
    });
    setTimeout(() => finish({ ok: false, rtt: null, info: null, reason: 'timeout' }), PROBE_TIMEOUT_MS * 2);
  });
}

// ================================================================
// Game-shape sustained test — send STREAM_BEGIN, listen for stream_data.
// ================================================================

// Game-shape sustained test with the mandatory server challenge.
//
// Handshake:
//   1. Send STREAM_BEGIN
//   2. Server replies with STREAM_CHALLENGE carrying a 16-byte HMAC token
//      in the payload area (offset 36). Or, if we are rate limited,
//      RATE_LIMITED.
//   3. Send STREAM_CONFIRM with the token echoed back.
//   4. Server emits STREAM_DATA for ~durationMs ms.
//   5. Send STREAM_STOP and close.
function sustainedTest({ host, port, nonce, durationMs }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let received = 0;
    let firstArrivalMs = null;
    let lastArrivalMs = null;
    const interArrivals = [];
    let maxGapMs = 0;
    let streamStarted = false;
    let rateLimited = false;
    // Track the server's own sequence numbers so we compute loss against
    // "what the server sent" rather than "what we thought we asked for".
    // This side-steps OS timer-resolution issues (e.g. Windows setInterval
    // granularity) and handshake timing.
    let minSeq = null;
    let maxSeq = null;
    const seenSeqs = new Set();

    sock.on('error', () => {});
    sock.on('message', (msg) => {
      const decoded = protocol.decode(msg);
      if (!decoded || !decoded.nonce.equals(nonce)) return;

      if (decoded.type === protocol.TYPE.RATE_LIMITED) {
        rateLimited = true;
        return;
      }

      if (decoded.type === protocol.TYPE.STREAM_CHALLENGE) {
        // Extract the 16-byte token and echo it back in a STREAM_CONFIRM.
        if (msg.length < protocol.TOKEN_OFFSET + protocol.TOKEN_SIZE) return;
        const confirm = protocol.encode({
          type: protocol.TYPE.STREAM_CONFIRM,
          nonce,
          sequence: 0,
          clientTsNs: nowNs(),
          totalSize: protocol.HEADER_SIZE + protocol.TOKEN_SIZE,
        });
        msg.copy(
          confirm,
          protocol.TOKEN_OFFSET,
          protocol.TOKEN_OFFSET,
          protocol.TOKEN_OFFSET + protocol.TOKEN_SIZE,
        );
        sock.send(confirm, port, host, () => {});
        streamStarted = true;
        return;
      }

      if (decoded.type !== protocol.TYPE.STREAM_DATA) return;
      const t = nowMs();
      if (firstArrivalMs == null) firstArrivalMs = t;
      if (lastArrivalMs != null) {
        const gap = t - lastArrivalMs;
        interArrivals.push(gap);
        if (gap > maxGapMs) maxGapMs = gap;
      }
      lastArrivalMs = t;
      // Only count each sequence once; the seenSeqs set makes us robust
      // against duplicates (a reordered/retransmitted packet shouldn't
      // inflate received count).
      if (!seenSeqs.has(decoded.sequence)) {
        seenSeqs.add(decoded.sequence);
        received++;
        if (minSeq == null || decoded.sequence < minSeq) minSeq = decoded.sequence;
        if (maxSeq == null || decoded.sequence > maxSeq) maxSeq = decoded.sequence;
      }
    });

    const begin = protocol.encode({
      type: protocol.TYPE.STREAM_BEGIN,
      nonce, sequence: 0,
      clientTsNs: nowNs(),
    });
    sock.send(begin, port, host, () => {});

    setTimeout(() => {
      const stop = protocol.encode({
        type: protocol.TYPE.STREAM_STOP,
        nonce, sequence: 0,
        clientTsNs: nowNs(),
      });
      sock.send(stop, port, host, () => {
        try { sock.close(); } catch (e) {}
        // Compute loss against what the server actually sent: the span
        // [minSeq, maxSeq] tells us how many packets left the server
        // during our observation window. Anything within that span that
        // we did not see is real loss. Anything outside the window
        // (setup, shutdown, timer granularity) is NOT counted as loss,
        // which prevents false alarms from short durations or slow
        // handshakes.
        let expected;
        let lossPct;
        if (minSeq == null || maxSeq == null) {
          // No data at all — report the nominal expectation so the
          // customer sees 100% loss loud and clear.
          expected = Math.round((durationMs / 1000) * SUSTAINED_PPS);
          lossPct = 100;
        } else {
          expected = (maxSeq - minSeq) + 1;
          lossPct = expected > 0 ? Math.max(0, (1 - received / expected) * 100) : 0;
        }
        resolve({
          expected,
          received,
          minSeq,
          maxSeq,
          rateLimited,
          streamStarted,
          lossPct,
          firstArrivalMs: firstArrivalMs == null ? null : firstArrivalMs,
          lastArrivalMs: lastArrivalMs == null ? null : lastArrivalMs,
          jitter: stats(interArrivals),
          maxGapMs,
          exceeded250ms: maxGapMs > 250,
        });
      });
    }, durationMs + 500);
  });
}

// ================================================================
// Test runner
// ================================================================

function filterPorts(allPorts, wanted) {
  if (!wanted) return allPorts;
  const set = new Set(wanted.map((n) => Number(n)));
  return allPorts.filter((p) => set.has(p.port));
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '   —  ';
  if (n < 10) return n.toFixed(2);
  if (n < 100) return n.toFixed(1);
  return Math.round(n).toString();
}

async function runTests(opts) {
  const host = opts.host;
  const resolved = await resolveHost(host);
  const nonce = randomNonce();
  console.log(`Session nonce: ${toHex(nonce)}`);
  console.log(`Resolved ${host} -> ${resolved}`);
  console.log('');

  const portsToTest = filterPorts(PORTS, opts.ports);

  const report = {
    version: 1,
    tool: 'sdg-connection-test client',
    startedAt: new Date().toISOString(),
    host, resolved,
    nonceHex: toHex(nonce),
    perPort: [],
    a2s: null,
    sustained: null,
    realServerA2S: null,
  };

  const rows = [];

  for (const p of portsToTest) {
    process.stdout.write(`  Testing ${p.proto} ${p.port} (${p.purpose}) ... `);
    const row = {
      proto: p.proto, port: p.port, category: p.category, purpose: p.purpose,
      reachable: false,
      rateLimited: false,
      loss: null,
      mtu: null,
      firstRttMs: null,
      error: null,
    };

    try {
      if (p.proto === 'udp') {
        const first = await udpProbe({ host: resolved, port: p.port, nonce, sequence: 0 });
        row.reachable = first.ok;
        row.firstRttMs = first.rtt;
        row.rateLimited = first.rateLimited;
        if (row.reachable) {
          row.loss = await udpLossTest({ host: resolved, port: p.port, nonce });
          if (row.loss.rateLimited > 0) row.rateLimited = true;
          const mtuRes = await udpProbe({
            host: resolved, port: p.port, nonce, sequence: 9999,
            payloadSize: MTU_PAYLOAD_BYTES,
          });
          row.mtu = { size: MTU_PAYLOAD_BYTES, ok: mtuRes.ok, rtt: mtuRes.rtt };
        }
      } else {
        const r = await tcpProbe({ host: resolved, port: p.port, nonce, sequence: 0 });
        row.reachable = r.ok;
        row.firstRttMs = r.rtt;
        row.error = r.reason;
      }
    } catch (e) {
      row.error = e.message;
    }

    report.perPort.push(row);
    rows.push(row);
    let status;
    if (row.reachable) status = 'OK';
    else if (row.rateLimited) status = 'RATE-LIMITED (SDG server)';
    else status = `FAIL${row.error ? ' (' + row.error + ')' : ''}`;
    console.log(status);
  }

  if (opts.a2s) {
    console.log('');
    process.stdout.write(`  Steam A2S_INFO query udp ${A2S_PORT} ... `);
    report.a2s = await a2sQuery({ host: resolved, port: A2S_PORT });
    console.log(report.a2s.ok ? `OK (${report.a2s.info.name})` : `FAIL (${report.a2s.reason})`);
  }

  if (opts.sustained) {
    console.log('');
    console.log(`  Game-shape sustained test udp ${GAME_SHAPE_PORT} for ${Math.round(opts.duration/1000)}s ...`);
    report.sustained = await sustainedTest({
      host: resolved, port: GAME_SHAPE_PORT, nonce,
      durationMs: opts.duration,
    });
    const s = report.sustained;
    console.log(`    received ${s.received}/${s.expected}  loss ${fmt(s.lossPct)}%  max gap ${fmt(s.maxGapMs)}ms${s.exceeded250ms ? '  [THROTTLING SIGNAL]' : ''}`);
  }

  if (opts.realServer) {
    const [rh, rp] = opts.realServer.split(':');
    console.log('');
    process.stdout.write(`  Real-server A2S_INFO ${rh}:${rp} ... `);
    const real = await a2sQuery({ host: await resolveHost(rh), port: Number(rp) });
    report.realServerA2S = { host: rh, port: Number(rp), ...real };
    console.log(real.ok ? `OK (${real.info.name})` : `FAIL (${real.reason})`);
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

// ---- Pretty table ----
function printTable(report) {
  console.log('');
  console.log('================================================================');
  console.log('RESULTS');
  console.log('================================================================');
  const header = 'proto  port   cat       reach  rtt(ms)  loss%   mtu1400  purpose';
  console.log(header);
  console.log('-'.repeat(header.length + 10));
  for (const r of report.perPort) {
    let reach;
    if (r.reachable && r.rateLimited) reach = 'OK* ';
    else if (r.reachable)              reach = 'OK  ';
    else if (r.rateLimited)            reach = 'RL  ';
    else                               reach = 'FAIL';
    const rtt = r.loss && r.loss.latency.avg != null ? fmt(r.loss.latency.avg) : fmt(r.firstRttMs);
    const loss = r.loss ? fmt(r.loss.lossPct) : '  —  ';
    const mtu  = r.mtu ? (r.mtu.ok ? 'OK ' : 'FAIL') : ' — ';
    console.log(
      `${r.proto.padEnd(5)}  ${String(r.port).padEnd(5)}  ${(r.category || '').padEnd(8)}  ${reach}   ${rtt.padStart(6)}  ${loss.padStart(5)}   ${mtu.padEnd(6)}  ${r.purpose}`
    );
  }
  if (report.perPort.some((r) => r.rateLimited)) {
    console.log('');
    console.log('  RL = SDG server rate-limited you. NOT an ISP problem.');
    console.log('  OK* = probes succeeded but the SDG server was also rate-limiting.');
    console.log('  Wait 60 seconds and try again. If RL persists, another device');
    console.log('  on your network or NAT may also be running the test.');
  }
  if (report.a2s) {
    const a = report.a2s;
    console.log('');
    console.log(`Steam A2S on udp ${A2S_PORT}: ${a.ok ? 'OK — server name "' + a.info.name + '"' : 'FAIL (' + a.reason + ')'}`);
  }
  if (report.sustained) {
    const s = report.sustained;
    console.log(`Game-shape 27016: ${s.received}/${s.expected} pkts, loss ${fmt(s.lossPct)}%, max gap ${fmt(s.maxGapMs)}ms${s.exceeded250ms ? '  [THROTTLING SIGNAL]' : ''}`);
  }
  if (report.realServerA2S) {
    const a = report.realServerA2S;
    console.log(`Real server ${a.host}:${a.port}: ${a.ok ? 'OK — "' + a.info.name + '"' : 'FAIL (' + a.reason + ')'}`);
  }
  console.log('');
}

// ---- Main ----
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.host) { printHelp(); process.exit(opts.help ? 0 : 1); }

  console.log('SDG Connection Test — client');
  console.log('----------------------------');
  console.log(`Target host : ${opts.host}`);
  console.log(`Ports       : ${opts.ports ? opts.ports.join(',') : 'all (' + PORTS.length + ' from shared/ports.js)'}`);
  console.log(`A2S query   : ${opts.a2s ? 'yes' : 'no'}`);
  console.log(`Sustained   : ${opts.sustained ? Math.round(opts.duration/1000) + 's on udp ' + GAME_SHAPE_PORT : 'no'}`);
  console.log(`Real server : ${opts.realServer || '(none)'}`);
  console.log(`JSON output : ${opts.json || '(none — console only)'}`);
  console.log('');
  console.log('This tool will send test packets to the above host only. It will');
  console.log('not transmit any other information. See ../docs/PROTOCOL.md and');
  console.log('../docs/TRANSPARENCY.md for details.');
  console.log('');

  if (!opts.yes) {
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) { console.log('Aborted.'); process.exit(0); }
  }
  console.log('');

  const report = await runTests(opts);
  printTable(report);

  if (opts.json) {
    await fs.writeFile(opts.json, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote JSON report to ${opts.json}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(2);
});
