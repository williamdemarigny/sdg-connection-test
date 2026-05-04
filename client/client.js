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
const { dgramTypeFor } = require('../shared/netUtils');

// ---- Tunables. Nothing here should need changing during normal runs. ----
const PROBE_TIMEOUT_MS   = 2000;
const LOSS_PACKET_COUNT  = 50;
const LOSS_INTERVAL_MS   = 100;      // 10 pps
// MTU sweep — three payload sizes that bracket the typical sub-tunnel MTU.
// 1200 should succeed everywhere. 1400 is the customary "safe" UDP MTU
// after carrier overhead. 1472 = 1500 - 20B IPv4 - 8B UDP, the max that
// fits in a 1500-byte ethernet frame. T-Mobile is documented to silently
// drop UDP above ~1400; the sweep makes that stair-step visible.
const MTU_SWEEP_BYTES    = Object.freeze([1200, 1400, 1472]);
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
    family: 0,                // 0 = OS-default (auto), 4 = force IPv4, 6 = force IPv6
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
    else if (a === '--duration')    {
      const sec = Number(argv[++i]);
      // Cap at 5 minutes. The default is 10 s; longer runs accumulate
      // sequence numbers in seenSeqs without bound. 300 s @ 60 pps =
      // 18000 entries, ~150 KB — well within reason. Beyond that the
      // test isn't really diagnostic anyway.
      if (!Number.isFinite(sec) || sec <= 0) {
        console.error(`--duration must be a positive number (got "${argv[i]}")`); out.help = true;
      } else if (sec > 300) {
        console.error(`--duration capped at 300 seconds (got ${sec})`); out.help = true;
      } else {
        out.duration = sec * 1000;
      }
    }
    else if (a === '--family') {
      const f = argv[++i];
      if (f === '4' || f === 'ipv4')      out.family = 4;
      else if (f === '6' || f === 'ipv6') out.family = 6;
      else if (f === 'auto' || f === '0') out.family = 0;
      else { console.error(`--family must be 4, 6, or auto (got "${f}")`); out.help = true; }
    }
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
  --family <4|6|auto>      Force IPv4 ('4'), IPv6 ('6'), or let the OS pick
                           ('auto', the default). Use '4' on a v6-native
                           network (e.g. T-Mobile 5G Home Internet w/ 464XLAT)
                           if you suspect Happy-Eyeballs is masking the
                           problem. The SDG test server is currently v4-only;
                           '6' will only succeed against AAAA-publishing
                           servers.
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

// Parse "host:port" robustly — handles bare IPv4/hostname plus the
// bracketed IPv6 form "[2001:db8::1]:27015". A naive split(':') would
// shatter an IPv6 literal across multiple colons, and a missing port
// would yield NaN that surfaces only as a confusing socket error.
function parseHostPort(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('host:port required');
  }
  // Accept any port string in the bracket form so we can give a specific
  // "invalid port" error rather than falling through to the ambiguous-IPv6
  // branch, which would produce a misleading message.
  const bracket = s.match(/^\[(.+)\]:(.+)$/);
  if (bracket) {
    const port = Number(bracket[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port "${bracket[2]}" in "${s}"`);
    }
    return { host: bracket[1], port };
  }
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) {
    throw new Error(`missing :port in "${s}" (use host:port, or [ipv6]:port)`);
  }
  // Reject pre-port colons that would indicate a bare IPv6 without
  // brackets — ambiguous form. e.g. "::1:80" could be addr=::1 port=80
  // or addr=::1:80 with no port.
  if (s.indexOf(':') !== lastColon) {
    throw new Error(`ambiguous IPv6 form "${s}"; wrap as [ipv6]:port`);
  }
  const host = s.slice(0, lastColon);
  const portStr = s.slice(lastColon + 1);
  const port = Number(portStr);
  if (host.length === 0) throw new Error(`empty host in "${s}"`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port "${portStr}" in "${s}"`);
  }
  return { host, port };
}

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
//
// Returns { address, family }, where family is 4 or 6. Pass family=0 to let
// the OS pick (Happy Eyeballs-ish behavior); pass 4 or 6 to force.
async function resolveHost(host, family = 0) {
  // Accept a raw IP without a DNS call. net.isIP returns 4, 6, or 0.
  const lit = net.isIP(host);
  if (lit) {
    if (family && lit !== family) {
      throw new Error(`--family ${family} but ${host} is a literal IPv${lit} address`);
    }
    return { address: host, family: lit };
  }
  const addrs = await dns.lookup(host, { family });
  return { address: addrs.address, family: addrs.family };
}

// ================================================================
// UDP probes
// ================================================================

// Send one SDGT probe and wait up to PROBE_TIMEOUT_MS for the reply.
// Returns one of:
//   { ok: true,  rtt: <ms> }                    success
//   { ok: false, rtt: null, rateLimited: true } server told us we're rate limited
//   { ok: false, rtt: null, rateLimited: false } timeout (real loss)
function udpProbe({ host, port, nonce, sequence, family = 4, payloadSize = protocol.HEADER_SIZE }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(dgramTypeFor(family));
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
async function udpLossTest({ host, port, nonce, family = 4 }) {
  const rtts = [];
  let received = 0;
  let rateLimited = 0;
  const sock = dgram.createSocket(dgramTypeFor(family));
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
function a2sQuery({ host, port, family = 4 }) {
  return new Promise((resolve) => {
    const requestBase = Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0x54,
      0x53, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x20,
      0x45, 0x6e, 0x67, 0x69, 0x6e, 0x65, 0x20,
      0x51, 0x75, 0x65, 0x72, 0x79, 0x00,
    ]);
    const sock = dgram.createSocket(dgramTypeFor(family));
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
function sustainedTest({ host, port, nonce, durationMs, family = 4 }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(dgramTypeFor(family));
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
  const { address: resolved, family } = await resolveHost(host, opts.family || 0);
  const nonce = randomNonce();
  console.log(`Session nonce: ${toHex(nonce)}`);
  console.log(`Resolved ${host} -> ${resolved} (IPv${family})`);
  console.log('');

  const portsToTest = filterPorts(PORTS, opts.ports);

  const report = {
    version: 1,
    tool: 'sdg-connection-test client',
    startedAt: new Date().toISOString(),
    host, resolved, family,
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
        const first = await udpProbe({ host: resolved, port: p.port, nonce, sequence: 0, family });
        row.reachable = first.ok;
        row.firstRttMs = first.rtt;
        row.rateLimited = first.rateLimited;
        if (row.reachable) {
          row.loss = await udpLossTest({ host: resolved, port: p.port, nonce, family });
          if (row.loss.rateLimited > 0) row.rateLimited = true;
          row.mtuSweep = [];
          for (let i = 0; i < MTU_SWEEP_BYTES.length; i++) {
            const size = MTU_SWEEP_BYTES[i];
            const res = await udpProbe({
              host: resolved, port: p.port, nonce, sequence: 9000 + i,
              family, payloadSize: size,
            });
            row.mtuSweep.push({ size, ok: res.ok, rtt: res.rtt });
          }
          // Backwards-compatible single field: the largest size that worked,
          // or the smallest probe's result if none worked. Consumers that
          // only knew about `mtu` (an object with size/ok/rtt) keep working.
          const lastOk = [...row.mtuSweep].reverse().find(s => s.ok) || row.mtuSweep[0];
          row.mtu = lastOk;
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
    report.a2s = await a2sQuery({ host: resolved, port: A2S_PORT, family });
    console.log(report.a2s.ok ? `OK (${report.a2s.info.name})` : `FAIL (${report.a2s.reason})`);
  }

  if (opts.sustained) {
    console.log('');
    console.log(`  Game-shape sustained test udp ${GAME_SHAPE_PORT} for ${Math.round(opts.duration/1000)}s ...`);
    report.sustained = await sustainedTest({
      host: resolved, port: GAME_SHAPE_PORT, nonce,
      durationMs: opts.duration, family,
    });
    const s = report.sustained;
    console.log(`    received ${s.received}/${s.expected}  loss ${fmt(s.lossPct)}%  max gap ${fmt(s.maxGapMs)}ms${s.exceeded250ms ? '  [THROTTLING SIGNAL]' : ''}`);
  }

  if (opts.realServer) {
    let rs;
    try {
      rs = parseHostPort(opts.realServer);
    } catch (e) {
      console.error(`  --real-server: ${e.message}`);
      report.realServerA2S = { ok: false, reason: `parse-error: ${e.message}` };
    }
    if (rs) {
      console.log('');
      process.stdout.write(`  Real-server A2S_INFO ${rs.host}:${rs.port} ... `);
      const realResolved = await resolveHost(rs.host, opts.family || 0);
      const real = await a2sQuery({ host: realResolved.address, port: rs.port, family: realResolved.family });
      report.realServerA2S = { host: rs.host, port: rs.port, family: realResolved.family, ...real };
      console.log(real.ok ? `OK (${real.info.name})` : `FAIL (${real.reason})`);
    }
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
  const header = 'proto  port   cat       reach  rtt(ms)  loss%   mtu      purpose';
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
    // Show the largest MTU size that succeeded, or — if none did — FAIL.
    let mtu = ' — ';
    if (r.mtuSweep && r.mtuSweep.length) {
      const lastOk = [...r.mtuSweep].reverse().find(s => s.ok);
      mtu = lastOk ? `${lastOk.size}` : 'FAIL';
    } else if (r.mtu) {
      mtu = r.mtu.ok ? `${r.mtu.size}` : 'FAIL';
    }
    console.log(
      `${r.proto.padEnd(5)}  ${String(r.port).padEnd(5)}  ${(r.category || '').padEnd(8)}  ${reach}   ${rtt.padStart(6)}  ${loss.padStart(5)}   ${mtu.padEnd(7)}  ${r.purpose}`
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
  console.log(`Address fam : ${opts.family === 0 ? 'auto (OS default)' : 'IPv' + opts.family}`);
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

if (require.main === module) {
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(2);
  });
}

module.exports = { parseArgs, stats, filterPorts, fmt, parseHostPort };
