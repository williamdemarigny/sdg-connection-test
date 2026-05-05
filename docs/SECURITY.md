# SDG Connection Test — Security Model

This document describes the threats the SDG Connection Test **server** is
designed to resist and the concrete defenses that mitigate them. It is
aimed at the ops team deploying the server and at security-conscious
players who want to understand the server's posture without needing to
read its source. The server implementation itself is operator-internal;
this document is the auditable specification of what the server is
*allowed* to do and what defenses bound its behavior.

Players reading about the **client** should look at
[TRANSPARENCY.md](./TRANSPARENCY.md) instead.

## Threat model

The server is deployed on a public IP with a large set of TCP and UDP
ports open to the entire internet. No authentication. No rate limiting
at the network edge. The client is a tool we publish from our own
website, so we have to assume every byte of it is known to attackers
and they will point modified copies at the server. Concretely, we are
defending against:

| # | Threat | Who cares |
|---|--------|-----------|
| T1 | **Reflected-amplification DDoS** using our server to flood a third-party victim | Upstream bandwidth, AUP with ISP, reputation |
| T2 | **Volumetric DoS against the server itself** (UDP flood, SYN flood, slow reads) | Server availability, host stability |
| T3 | **Resource exhaustion inside the process** (unbounded maps, file descriptors) | Availability, memory pressure on the host |
| T4 | **Disk exhaustion via the session log** | Availability of the host's `/var` |
| T5 | **Oversized or malformed datagrams** designed to crash the parser | Availability |
| T6 | **Container escape or privilege abuse** if an attacker somehow gets code execution | Host integrity |
| T7 | **Port collision with privileged services on the host** | Operator footgun; accidental lockout |
| T8 | **False positives for legitimate players** (our limits triggering before the ISP's) | Tool accuracy, customer trust |
| T9 | **Interference with a real Torch/SE server** on the same host | Production impact |

## Defenses

Each row below describes a concrete defense the server implements. The
behavior is observable from the client side (e.g. by sending a probe and
inspecting the response shape) and verifiable end-to-end without server
source access.

### T1 — Reflected amplification

This is the top concern because SDG is a game-server hoster and any
amplification factor is unacceptable.

**Steam A2S_INFO (UDP 27015).** Answering the 25-byte request with a
~120-byte info reply is a ~5× amplifier. We implement Valve's December
2020 post-reflection challenge protocol: a first-time request gets a
9-byte S2C_CHALLENGE reply, and the full info reply is only sent after
the client echoes the 4-byte challenge. The challenge is a stateless
HMAC of `(secret, "a2s", src-ip, 30-second time bucket)`, so there is
no per-client memory on the server.

**Game-shape stream (UDP 27016).** This was by far the largest
amplifier in the original design — a 36-byte `STREAM_BEGIN` produced
roughly 240 KB of outbound traffic to the source address (factor
~6600). We now require a two-step handshake: `STREAM_BEGIN` is answered
with a `STREAM_CHALLENGE` carrying a 16-byte HMAC token
(`HMAC(secret, "stream", ip, port, nonce, bucket)`), and the stream is
only started after a valid `STREAM_CONFIRM`. A spoofed source address
cannot see the challenge and therefore cannot forge a valid confirm,
so no stream ever starts.

**SDGT echo (all UDP ports).** The echo reply is byte-for-byte the
same size as the probe, so it is non-amplifying by construction. No
additional defense needed.

**Rate-limit replies.** `RATE_LIMITED` packets are always exactly 36
bytes (the SDGT header size), which is strictly smaller than any probe
up to the 1400-byte MTU test. This reply is therefore a
**de-amplifier**: it costs an attacker more bytes to send a probe than
it does for the server to refuse it.

**Endpoint reflection (REFLECT_REPLY, type 9).** Phase 1 added a
reflection feature for NAT-type classification. The server's reply
MUST be padded (or truncated) to **exactly the inbound probe size**;
the client cooperates by sending reflection-requesting probes at >=60
bytes. A reflection-requesting probe smaller than 60 bytes MUST be
answered with `RATE_LIMITED` (36 bytes, de-amplifying) rather than a
truncated reflection — never let the client's bug become the server's
amplifier.

**Capability reply (CAPABILITIES, type 12).** Same rule: the reply
MUST be no larger than the inbound capability probe. Pad or truncate
to match.

**Stream tally (STREAM_TALLY, type 11).** Sent only after a successful
`STREAM_CONFIRM` for an `up` or `both` direction stream, so it is
gated behind the same anti-spoof handshake as the existing downstream
data. Three copies of the tally are sent for loss tolerance; the
total tally output is bounded at three times a single ~80-byte
packet, which is small relative to the legitimate inbound up-stream
the client just produced.

**Up-stream itself (STREAM_DATA_UP, type 10).** This is client-to-
server traffic, so the server is the *recipient*, not a sender — by
construction it is not an amplifier. The risk is that an attacker
uses our server as a sink for noise (DoS T2, see below) or that
unbounded server-side state is allocated. See T3 for the relevant
caps.

### T2 — Volumetric DoS against the server

We layer three rate limits:

1. **Aggregate token bucket** (GlobalBucket, 2000 tokens capacity,
   2000 tokens/s refill). Caps server-wide UDP handling regardless of
   how the traffic is distributed across source IPs. If a flood
   exceeds this, excess packets are dropped silently after the
   datagram-size check but before any protocol handling.
2. **Per-source-IP token bucket** (TokenBucket, 200 capacity, 50 pps
   refill). Stops any single source address from monopolizing the
   server. Calibrated at ~5-20× the legitimate client pattern (which
   averages ~10 pps per source IP during a full test run). The bucket
   map is LRU-capped at 10 000 keys so an IP-scanning attacker cannot
   grow memory unboundedly.
3. **TCP concurrency** (ConcurrencyLimiter, 5 conns/ip, 200
   global). Stops slowloris-style fd exhaustion. A connection that
   cannot acquire a slot is immediately destroyed with no reply.

When a *legitimate* client is rate-limited (e.g. two players behind the
same CGNAT IP), we send back a 36-byte `RATE_LIMITED` packet rather
than dropping silently. The client (see
[`../client/client.js`](../client/client.js)) distinguishes this from
real ISP packet loss in its result table so the limiter never causes a
false positive against the ISP under test. This matters because the
entire point of the tool is blame attribution.

### T3 — In-process resource exhaustion

- Per-IP bucket map is LRU-capped (10 000 entries). Oldest eviction on
  insertion.
- Session log is capped to 5000 in-memory sessions. Oldest flushed on
  insertion.
- New-session creation is itself rate-limited (500/min global) so that
  an attacker rolling nonces cannot force unbounded flush work.
- TCP reads are capped at 4 KB/connection with a 5-second idle
  timeout.
- Docker `pids_limit: 128` and `nofile 4096` ulimits cap the process
  at the kernel level as a backstop.

**Phase 1 up-stream caps (server team requirements):**

- **Per-IP up-stream concurrency: 1.** A second up-stream from the
  same source IP while one is active MUST be answered with
  `RATE_LIMITED` (36 bytes), never a second `STREAM_CHALLENGE`.
- **Global up-stream concurrency: 20.** Bounds total state.
- **Hard up-stream duration cap: 300 s.** The server MUST run an
  absolute timer from `STREAM_CONFIRM` and tear down the stream's
  bookkeeping at the cap regardless of whether the client sent
  `STREAM_STOP`. If the client dies mid-test, server state must
  self-clean — the client is untrusted by construction.
- **Up-stream byte cap: 30 MB per stream.** A 200-pps × 400-B × 300-s
  upper bound is ~24 MB; 30 MB gives a small margin. Excess inbound
  bytes from the same `(ip, port, nonce)` tuple after the cap are
  silently dropped.
- **Separate token bucket for the up-stream window.** When a
  `STREAM_CONFIRM` is accepted with `direction != down`, allocate
  300 s of up-stream credit (e.g. 60 000 packets) bound to the
  challenge token. This bucket is separate from the per-IP general
  bucket so the test does not trip the rate limiter against itself.
- **Replay protection.** The `STREAM_CHALLENGE` HMAC input MUST
  include the direction byte:
  `HMAC(secret, "stream", direction, ip, port, nonce, bucket)`.
  This prevents a captured downstream token from being replayed to
  flip a downstream into an up-stream the source IP did not request.

### T4 — Log-driven disk exhaustion

- Hard 50 MB cap per session log file.
- Automatic rotation to `sessions.log.old` (truncating any previous
  .old) when the cap is exceeded.
- Rotation check is throttled to at most once per 10 s to bound the
  stat() rate.
- Logger **MUST NEVER** crash the server: any write or stat failure
  disables logging silently and the server continues. This is
  intentional — session logs are nice-to-have, but availability of the
  actual diagnostic is the primary goal.

### T5 — Malformed / oversized datagrams

- UDP datagrams > 1500 bytes are dropped at the top of
  `handleUdpMessage` before any parser runs.
- All binary parsing is defensive: `protocol.decode` returns `null` on
  any mismatch and never throws. `a2sResponder.isA2SInfoRequest`
  performs an exact-length + exact-prefix check.
- The parser is small enough (a few dozen lines total) to audit
  exhaustively.

### T6 — Container escape / privilege abuse

The server runs as a Docker container on a host kernel. If the worst
happens and an attacker gets code execution inside the container, we
want them to have nothing useful to escalate with.

- **Read-only root filesystem** (`read_only: true`). A /tmp tmpfs and
  a named log volume are the only writable surfaces.
- **All capabilities dropped** (`cap_drop: [ALL]`). We never call
  `mount`, never bind privileged ports, never send raw packets.
- **no-new-privileges** blocks setuid binaries from escalating inside
  the container.
- **Non-root UID** (`user: 1001:1001`) set in both the Dockerfile
  (fixed UID 1001) and the compose file.
- **Resource limits** (0.5 CPU, 256 MB, pids 128, nofile 4096, nproc
  128) fence the blast radius of any leak or abuse.
- **json-file log driver capped at 3×10 MB** so container stdout/stderr
  cannot fill the host disk either.

### T7 — Port collision with privileged services on the host

The original design listened on TCP 80, TCP 443, and UDP 443 as
"baseline" controls. Two problems with that on a hardened deployment:
the host may already bind one of those ports for its own
administrative interface, and binding 80/443 requires
`CAP_NET_BIND_SERVICE` — which the container deliberately drops as
part of T6.

**Resolution:** baseline ports are now TCP 27080, TCP 27443, and UDP
27443. These are equivalent as a control — a client whose generic-
high-port tests pass while the SE/Steam-port tests fail is still
strong evidence that the ISP is specifically mistreating SE/Steam
traffic. If you need a real-port-443 QUIC test (to catch
T-Mobile-style QUIC blocking), run that from the client using a
separate public QUIC endpoint instead of rewiring the SDG server.

Port matrix: see [`../shared/ports.js`](../shared/ports.js).

### T8 — False positives against legit players

The most insidious failure mode of a rate limiter on a diagnostic tool
is misattributing our own rate-limit drops as "ISP packet loss" in the
customer's report. Two defenses:

1. Rate-limit drops produce a distinguishable `RATE_LIMITED` reply,
   not silent loss. The client classifies these separately in the
   results table (shown as `RL` or `OK*`, never rolled into the
   loss%).
2. Limits are calibrated at roughly 5-20× the measured legit client
   pattern, so a single player never trips them and two-three CGNAT
   neighbors running the test in parallel should still fit.

The client's RL/loss distinction is implemented in
[`../client/client.js`](../client/client.js) — see `udpProbe`,
`udpLossTest`, and the `printTable` function.

### T9 — Interference with a real Torch/SE server

If you deploy the test server on the same host that runs a real SE
dedicated server, **the two will conflict on UDP 27015 / 27016**. This
is deliberate: the whole point of the test is to probe the same ports,
from the same IP, with the same shape of traffic. But the conflict is
real and operational.

**Recommended split:**
- **Separate host, separate public IP** is strongly preferred. Run the
  test server on a dedicated VM. The customer still gets equivalent
  diagnostic data because ISP treatment of UDP 27016 is IP-agnostic at
  the DPI layer: if T-Mobile drops SE traffic to one public IP it drops
  it to all of them.
- **Same host, different IP** is acceptable if the host has multiple
  public addresses. Bind the test server to the second IP via
  `SDG_CT_BIND` and set NAT rules accordingly.
- **Same host, same IP** is only safe during a scheduled maintenance
  window when Torch is stopped. This is rarely what you want.

## What we explicitly did not do (and why)

- **No edge rate limiting (iptables/ipset/nftables).** Edge rate
  limits are easy to desync from the application's own behavior — the
  edge can drop a packet the app would have accepted, or vice versa,
  and the disagreement can cause the false-positive failure mode in
  T8. All rate limiting is in-process so the limits visible to the
  client (`RATE_LIMITED` replies) are exactly the limits the server
  is actually enforcing.
- **No TLS / no mTLS.** The tool is deliberately a dumb echo and must
  not be indistinguishable in shape from a real game server. Adding
  TLS would change the traffic fingerprint and break the
  game-shape test's validity.
- **No ASN-based allowlisting.** We want T-Mobile customers to be able
  to run the test against the server — that is the entire point.
- **No CAPTCHA / no account wall.** Auth would again change the
  traffic fingerprint and would raise the bar for legitimate players
  well above "can I run a Node script".

## Monitoring hooks

The server prints its configured limits at startup, which is recorded
by the Docker json-file log driver. For runtime visibility:

```
# Streaming log watch
docker logs -f sdg-connection-test
# Session log (rotated at 50 MB)
docker exec sdg-connection-test cat /var/log/sdg-ct/sessions.log
```

Each line in the session log includes a `rateLimited` counter so you
can tell at a glance whether a given source IP is hitting the bucket.
If a specific legitimate customer ever shows non-zero `rateLimited`
with non-zero `counts`, the limits need retuning — not the customer.

## Reporting issues

Security findings of any kind go to the SDG DevOps team directly, not
through a public issue. Do not post exploits or PoCs anywhere public —
the tool is a support utility, not a security product, and any real
vulnerability is trivially observable once it is documented.
