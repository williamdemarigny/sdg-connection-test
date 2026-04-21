# SDG Connection Test

A small client/server diagnostic for proving or disproving whether a
specific ISP is blocking or throttling the UDP traffic that Space
Engineers, Torch, and Steam depend on.

Built in response to a real customer case: Space Engineers worked fine
over a Verizon cellular hotspot and failed over T-Mobile 5G Home
Internet, from the same laptop, against the same Torch server. We needed
hard evidence rather than another round of "try a different DNS server".

## How it works

1. The **server** listens on every TCP and UDP port SE, Torch, and Steam
   use. On UDP 27015 it answers real Steam A2S_INFO queries. On UDP
   27016 it can push a game-shape traffic stream (~60 pps, 200-400 byte
   payloads, 10 seconds) on demand. Everything else is a plain echo for
   our small binary probe protocol.
2. The **client** probes every (proto, port) pair for reachability, loss
   rate, latency stats, and MTU behavior, does a real Steam A2S query,
   runs the sustained game-shape test, and optionally probes the
   customer's actual Torch server for comparison. Results print to the
   console and, on request, to a JSON file.

## Repository layout

```
SDG-Connection-Test/
  shared/ports.js          single source of truth for the port matrix
  shared/protocol.js       binary packet format, shared by client + server
  server/                  Node.js server, Docker/compose, session logger
  client/                  Zero-dep Node.js client + privacy-first README
  docs/PROTOCOL.md         byte-level wire protocol reference
  docs/TRANSPARENCY.md     for security-conscious players
  docs/DEPLOY-TRUENAS.md   TrueNAS SCALE deployment walkthrough
```

## Running locally

```
# Terminal 1 — server
cd server
node server.js

# Terminal 2 — client
cd client
node client.js --host 127.0.0.1 --yes
```

Every row should come back green. This is the smoke test for any
changes.

## Deploying

See [`docs/DEPLOY-TRUENAS.md`](docs/DEPLOY-TRUENAS.md). Short version:
build with `docker compose build` in `server/`, then install as a
TrueNAS Custom App with the included compose file.

## Auditing the client

See [`client/README.md`](client/README.md) and
[`docs/TRANSPARENCY.md`](docs/TRANSPARENCY.md). The client is a single
~500-line JavaScript file with zero runtime dependencies. Paranoid
players are actively encouraged to read it before running it.

## Zero dependencies

Both server and client use only Node.js built-ins. There is no `npm
install` step for either side. This is intentional: it keeps the client
auditable and the server's supply chain minimal.

Required: **Node.js 18 or later**.
