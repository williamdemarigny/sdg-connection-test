# SDG Connection Test — Transparency Notes for Paranoid Players

If you are reading this because you do not want to run a random tool from
the internet on your machine, thank you. You are doing the right thing.
This document tries to answer, concretely and verifiably, every reasonable
question a security-conscious player might have about the client.

## The short version

The client is a single JavaScript file, around 500 lines, that uses only
Node.js built-in modules. It sends two kinds of packet: a small binary
probe of our own design, and the standard public Steam A2S_INFO query.
Every byte is documented in [PROTOCOL.md](./PROTOCOL.md). It never reads
files from your machine, never reads environment variables, and never
makes a network request to anything except the `--host` (and optional
`--real-server`) you pass on the command line. The source is intended to
be skimmable in ten minutes by anyone with basic JavaScript literacy.

## What you should verify for yourself

Trust is earned. Here is how to earn it.

### 1. Inspect the code

The complete client is in [`../client/client.js`](../client/client.js),
plus two tiny helpers in [`../shared/ports.js`](../shared/ports.js) and
[`../shared/protocol.js`](../shared/protocol.js). Together they are under
700 lines of commented JavaScript.

Things to search for:

- `require(` — lists every module loaded. You should see only
  `net`, `dgram`, `dns/promises`, `crypto`, `fs/promises`, `readline`,
  `perf_hooks`, and the two sibling files in `../shared/`. Nothing else.
- `fs.` — every file access. In the client, `fs.writeFile` is used only
  when you pass `--json <file>` and writes only to that file.
- `process.env` — not used at all in the client.
- `child_process`, `eval`, `Function(`, `vm.`, `http`, `https`, `fetch`,
  `import(` — none of these appear. Try grepping for them.
- `net.Socket`, `net.createConnection`, `dgram.createSocket` — these are
  the only outbound network calls. Every one of them writes to
  `resolved` (the IP you passed on `--host`) except the optional
  `--real-server` test.

### 2. Watch the packets

Run the client with Wireshark capturing on your active NIC. The client
prints a 16-character hex session nonce at startup. Every outbound packet
has those same 8 bytes at offset 8, so you can filter your capture with:

```
frame contains <nonce-as-hex>
```

Every packet in the filtered list will match one of the layouts in
[PROTOCOL.md](./PROTOCOL.md). There will be no packets to any host other
than the one you passed on `--host` (and `--real-server`, if you used it).

### 3. Unplug your network

With no network interface available, the client will fail every test and
exit cleanly. There is no offline "fallback" behavior, no local database
read, no cached anything. It is strictly a network diagnostic.

### 4. Run it in a sandbox

The tool is entirely happy to run in:

- a Windows Sandbox (`WindowsSandbox` feature)
- a throwaway VM
- a Docker container with `node:20-alpine`

If you do not want to install Node.js on your main machine, any of the
above will work.

## Why we do NOT emulate the real Space Engineers gameplay protocol

You might reasonably ask: if you are trying to diagnose SE connectivity,
why not just speak the real SE protocol?

The real Space Engineers gameplay protocol on UDP 27016 is
**SteamNetworkingSockets** (Valve's encrypted, handshaked, Steam-relay-aware
transport). Speaking it honestly would require either:

- Valve's closed-source Steamworks SDK with a real App ID, or
- the open-source `GameNetworkingSockets` C++ library as a native
  dependency.

Either option would add a large, hard-to-audit native binary to the
client. That would completely defeat the purpose of shipping a small,
readable, zero-dependency tool. So we deliberately don't.

Instead, we:

1. Prove **L3/L4 reachability** on every port SE and Steam use, with
   detailed loss, jitter, and MTU measurements.
2. Do a **real Steam A2S_INFO** query on UDP 27015 (this is the same
   query the Steam server browser uses, and Torch answers it natively).
3. Send a **game-shape sustained stream** on UDP 27016 from the test
   server to the client at the same packet rate and size distribution as
   real SE gameplay. This does not reproduce the encrypted handshake, but
   it does give any ISP DPI the same traffic fingerprint to trip on.
4. Optionally (`--real-server`) send a real A2S_INFO directly to your
   actual Torch/SE server for a true end-to-end comparison.

If all L3/L4 tests pass on ISP A and fail on ISP B, and the A2S query
behaves the same way, then ISP B is the problem regardless of whether we
ever completed a real SteamNetworkingSockets handshake.

## Anything we missed?

If you find something in the client code that looks wrong, misleading,
or nefarious, please tell us. The whole point of this tool is
transparency, and a tool that cannot be audited honestly is worse than no
tool at all.

The server source is operator-internal — what the server is permitted to
do is bounded by the protocol in [PROTOCOL.md](./PROTOCOL.md) and the
defenses described in [SECURITY.md](./SECURITY.md). Nothing the server
sends back can affect your machine beyond the response packets to probes
the client itself sent. The client is the only side of this conversation
running in your environment, and that is the side we encourage you to
audit.
