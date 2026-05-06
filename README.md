# SDG Connection Test

A small client/server diagnostic for proving or disproving whether a
specific ISP is blocking or throttling the UDP traffic that Space
Engineers, Torch, and Steam depend on.

Built in response to a real customer case: Space Engineers worked fine
over a Verizon cellular hotspot and failed over T-Mobile 5G Home
Internet, from the same laptop, against the same Torch server. We needed
hard evidence rather than another round of "try a different DNS server".

This repository contains the **client** and the **shared protocol
definitions** that both sides of the diagnostic speak. The server is
operator-deployed; this repo contains everything you need to install
the client, audit what it does on your machine, and run it against an
operator-supplied test endpoint. The server's security and privacy
posture is documented in [`docs/SECURITY.md`](docs/SECURITY.md) and
[`docs/PRIVACY.md`](docs/PRIVACY.md) so you can reason about what the
server is permitted to do without needing its source.

## How it works

1. The **server** (operator-deployed) listens on every TCP and UDP port
   SE, Torch, and Steam use. On UDP 27015 it answers real Steam
   A2S_INFO queries. On UDP 27016 it can push a game-shape traffic
   stream (~60 pps, 200-400 byte payloads, 10 seconds) on demand.
   Everything else is a plain echo for our small binary probe protocol.
   The wire format is fully specified in
   [`docs/PROTOCOL.md`](docs/PROTOCOL.md).
2. The **client** (in this repo) probes every (proto, port) pair for
   reachability, loss rate, latency stats, and MTU behavior, does a
   real Steam A2S query, runs the sustained game-shape test, and
   optionally probes the customer's actual Torch server for comparison.
   Results print to the console and, on request, to a JSON file.

## Repository layout

```
client/                  Zero-dep Node.js client + privacy-first README
shared/ports.js          single source of truth for the port matrix
shared/protocol.js       binary packet format, shared by client + server
shared/netUtils.js       small IP / dgram helpers shared by client + server
docs/PROTOCOL.md         byte-level wire protocol reference
docs/SECURITY.md         server-side security model and hardening
docs/PRIVACY.md          what the operator-deployed server may log
docs/TRANSPARENCY.md     for security-conscious players
```

## Download

Customer-facing download page: <https://sdg.knowledgeondemand.net>

Direct release link: [latest GitHub Release](https://github.com/sdg-net/sdg-connection-test/releases/latest).

## Running the client

```
cd client
node client.js --host <operator-supplied-host> --yes
```

Every row should come back green. Loss > 0 indicates a problem; the
client distinguishes ISP loss from server-side rate-limiting in the
`RL` column so the limiter never causes a false positive against the
ISP under test.

To run the full test against a JSON report:

```
node client.js --host <host> --json report.json
```

### Diagnostics included in every default run

Every default run includes six targeted tests for the harder cases —
carrier NAT timeouts, symmetric NAT blocking peer-to-peer, uplink-only
throttling, policer-vs-shaper fingerprinting, per-5-tuple shaping, and
DPI by payload signature. Total runtime ~4 minutes; pass `--full` for
the longer NAT-idle ladder (~10 minutes).

| Test | What it diagnoses |
| --- | --- |
| NAT idle (30 + 60 s) | CGNAT idle-mapping eviction (the most common T-Mobile 5G Home symptom — "I get disconnected after a few minutes") |
| NAT type | Symmetric vs cone NAT — tells you whether peer-to-peer needs a relay |
| Bidirectional sustained (`both`) | Uplink-only throttling, which is invisible to a downstream-only sustained test |
| Burst-vs-steady | Policer (burst loss, steady fine) vs shaper (loss at both rates) vs random loss |
| Source-port fan-out | Per-5-tuple shaping or unlucky ECMP path: probes from 4 different source ports, diverging loss → per-flow discrimination |
| Payload-shape sensitivity | DPI by content fingerprint: same packet rate with three different payload patterns; diverging loss → DPI is making decisions on payload content |

Plus two metrics derived from the data the existing loss tests
already collect, with no extra packets sent: a loss-burst histogram
(runs of consecutive drops, bucketed) and a packet-reordering count
(SE's interpolation stutters on reorder, so this is a real
complaint pattern).

The server-dependent tests (`nat-type` and `bidir up/both`)
gracefully degrade against a v1.0.0 server: the client probes for
support and prints `SKIPPED (server too old)` if not present.
Reflected public IP in the `--json` report is redacted by default —
pass `--include-public-ip` to opt in.

To dial back: `--no-nat-idle`, `--no-nat-type`, `--no-burst`,
`--no-source-fanout`, `--no-payload-shape`, `--bidir down`, or
pass `--ports` to limit the per-port sweep.

## Auditing the client

See [`client/README.md`](client/README.md) and
[`docs/TRANSPARENCY.md`](docs/TRANSPARENCY.md). The client is a single
~2,200-line JavaScript file with zero runtime dependencies. Paranoid
players are actively encouraged to read it before running it.

## Zero runtime dependencies

The client uses only Node.js built-ins. There is no `npm install` step.
This is intentional: it keeps the client auditable and its supply chain
minimal — the entire surface is the Node.js standard library plus the
three small files in `shared/`.

Required: **Node.js 20 or later**.
