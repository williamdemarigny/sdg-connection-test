# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## SemVer policy

The project follows SemVer with one additional rule: a change that bumps
the `VERSION` byte in [`shared/protocol.js`](shared/protocol.js) — which
defines the on-the-wire protocol — is by definition a **major** version
bump for both client and server. A v1 client cannot be expected to talk
to a v2 server or vice versa. Compatibility within a major is
guaranteed.

## [Unreleased]

### Added — Phase 1 diagnostics

Four new opt-out diagnostic tests targeting the carrier failure modes
the original v1.0.0 sweep couldn't surface. **All four default ON**:
the whole point of the tool is blame attribution, and these are the
tests that catch the cases the default L3/L4 sweep misses. Total
runtime ~3-4 minutes; pass `--full` for the long NAT-idle ladder
(~10 minutes).

- **NAT idle-timeout probe** (`--no-nat-idle` to skip). Holds one UDP
  socket open and probes after 30 + 60 seconds of idle (or
  30/60/120/300 with `--full`). Catches CGNAT mapping eviction
  even when the data path appears to recover, by comparing the
  reflected source port before and after each idle window. Covers
  the canonical T-Mobile 5G Home "I get disconnected after a few
  minutes" symptom.
- **Endpoint reflection / NAT type** (`--no-nat-type` to skip).
  Sends two probes from one socket to two destination ports and
  classifies the result as cone (peer-to-peer works), symmetric
  (peer-to-peer needs a relay like Steam Datagram), or no-NAT
  (IPv6).
- **Bidirectional sustained stream** (`--bidir down` for legacy
  downstream-only). The default sustained test now exercises both
  directions; the up-stream phase reveals uplink-only throttling
  that is invisible to a downstream-only test.
- **Burst-vs-steady policer test** (`--no-burst` to skip). 100
  packets at max kernel rate, then 100 at 10 pps, on UDP 27443
  (baseline). Loss diff fingerprints policer vs shaper vs random
  loss.

Wire protocol additions (no VERSION bump — Phase 1 is fully
backwards-compatible with v1.0.0 servers, which is why we kept
VERSION=1):

- `TYPE.REFLECT_REPLY` (9) — server echoes observed source IP/port,
  padded to inbound probe size for non-amplification.
- `TYPE.STREAM_DATA_UP` (10) — client→server up-stream payload.
- `TYPE.STREAM_TALLY` (11) — server→client end-of-stream tally,
  sent 3× for loss tolerance.
- `TYPE.CAPABILITIES` (12) — feature bitmap (reflection,
  bidirectional, nat-idle-aware) returned in response to a probe
  with the magic sequence value `0xCAFEBABE`. Allows the client to
  detect server support before running server-dependent tests and
  print `SKIPPED (server too old)` rather than fabricate a verdict.
- `flags` byte (offset 6 of the SDGT header) — previously reserved
  zero. On `PROBE`: high bit (`FLAG_REFLECT`, `0x80`) opts into
  reflection. On `STREAM_BEGIN` and `STREAM_CONFIRM`: low byte
  carries the direction code (0=down, 1=up, 2=both).
- `STREAM_CHALLENGE` HMAC input now includes `direction` when
  `direction != 0`. A captured down-token cannot be replayed in
  an up-direction CONFIRM. The `direction == 0` path is byte-
  identical to the v1.0.0 HMAC for full wire compat.

CLI additions:
- `--full` extends the NAT idle ladder to 30/60/120/300 s.
- `--nat-idle <s1,s2,...>` overrides the default ladder.
- `--bidir <down|up|both>`, `--up-pps <n>` for the bidirectional
  sustained variant.
- `--no-nat-idle`, `--no-nat-type`, `--no-burst` to dial back.
- `--include-public-ip` opts into a non-redacted reflected source
  IP in the JSON report (default is to redact the host portion).

### Changed
- Default sustained test direction is now `both`. Pass `--bidir down`
  for the legacy v1.0.0 downstream-only behavior.
- Default run includes the four Phase 1 tests. Use `--no-*` flags
  to dial back, or `--ports` to limit the per-port sweep.
- Test suite grew from 81 (v1.0.0) to 138 client + 208 server tests.

### Security
- Anti-amplification invariant extended to the new types: every
  server reply (REFLECT_REPLY, CAPABILITIES, STREAM_TALLY) is
  bounded to ≤ inbound probe size. Reflection probes < 60 bytes
  and capability probes < 40 bytes get RATE_LIMITED (36 bytes,
  de-amplifying) instead of a truncated reply.
- Up-stream concurrency cap (1 per source IP, 20 global), 30 MB
  byte cap per stream, hard 300 s server-side timer independent
  of `STREAM_STOP` — server state cleans itself up if the client
  dies mid-test.
- Direction folded into the STREAM_CHALLENGE HMAC: a token issued
  for `direction=down` does not verify against a `direction=up`
  CONFIRM. Documented in [`docs/SECURITY.md`](docs/SECURITY.md) T1.

### Privacy
- JSON report redacts the host portion of any reflected public IP
  by default (v4: `1.2.3.x`; v6: keeps first /32 + redacted
  marker). The README invites users to share their report for
  support, so this prevents a CGNAT egress IP from becoming a
  shared identifier without explicit opt-in (`--include-public-ip`).

## [1.0.0] — 2026-05-04

First public release.

### Added
- Client `--family <4|6|auto>` flag. Default is `auto` (whatever the
  OS resolver picks). Use `4` to force IPv4 against the SDG test
  server (currently v4-only) on a v6-native client like T-Mobile 5G
  Home Internet with 464XLAT, where Happy Eyeballs can otherwise
  perturb the measurement.
- Client MTU sweep: the per-port MTU probe now runs at 1200, 1400,
  and 1472 bytes instead of a single 1400. Output JSON gains a
  `mtuSweep: [{size, ok, rtt}, ...]` array per UDP port; the legacy
  `mtu` field is preserved as the largest size that succeeded.
- Server `createServer({ ... })` factory exposing `start()`,
  `stop()`, and `addresses()`. Lets tests bind to ephemeral ports
  (`bindOverride`) and override log path / ASN lookup / rate
  limits / streamer duration. Production behavior unchanged when
  invoked as `node server/server.js`.
- `server/ipToAsn.js` `createLookup({ tsvPath })` factory so tests
  can exercise the missing-file degrade path without touching the
  bundled TSV.
- `shared/netUtils.js` with `normalizeIp()` (strips v4-mapped
  `::ffff:` prefix) and `dgramTypeFor()` (selects `udp4`/`udp6` by
  family).
- Test suite: 149 tests across `shared/`, `server/`, and `client/`,
  using only `node:test` and `node:assert/strict`. Includes a
  full client-server integration test that spins up the server on
  ephemeral ports and exercises the protocol end-to-end.
- CI (operator-internal): `test` (Node 20 + 22), `docker-build`, and
  `zero-dep-guard` jobs. The guard enforces no npm dependencies, no
  imports outside Node built-ins / `./*` / `../shared/*`, and that
  `client/` stays a single non-test JS file. The same enforcement is
  applied to the public `client/` and `shared/` trees by maintainers
  on PR review.
- [`LICENSE`](LICENSE) (MIT).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — acceptable use, the
  zero-dep rule, repo layout, and the port-addition recipe.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — what the session log
  collects, the 50 MB / two-generation retention ceiling, GDPR
  posture, operator responsibilities.
- `docs/FIELD-TEST-PROTOCOL.md` (operator-internal) — the methodology
  for the carrier-comparison field test (5 trials per carrier × 3 time
  windows × negative-control target × traceroute capture × server-side
  correlation × MTU sweep).

### Changed
- Deployment doc restructured (operator-internal). The recommended
  path is now a dedicated single-homed **Ubuntu Server 24.04 LTS** VM
  in the DMZ (24.04.3 or newer), provisioned manually with whichever
  hypervisor tooling fits your workflow. This avoids the
  asymmetric-routing trap on multi-homed hosts (Linux routes egress by
  destination, not by inbound interface; a host-networked container
  on a multi-homed host silently sends replies out the wrong NIC).
  VM specs: 1 vCPU / 2 GB RAM (1 GB minimum) / 8 GB disk / single NIC
  on the DMZ VLAN. The 2 GB recommendation reflects the install +
  steady-state + load budget — 512 MB is over-budget at idle once
  Docker daemon and the
  256 MB-capped container are added.
  Earlier draft revisions documented Hyper-V provisioning via the
  `taliesins/hyperv` Terraform provider; that snippet was removed in
  favor of hypervisor-agnostic VM-spec guidance.
- `client/client.js` wraps `main()` in `if (require.main === module)`
  and exports `parseArgs`, `stats`, `filterPorts`, and `fmt` so the
  file can be required from tests without spawning a CLI run.
- `shared/ports.js` deep-freezes individual entries (not just the
  outer array). The matrix is "single source of truth a suspicious
  player has to audit" — defensive immutability matters here.
- `server/sessionLog.js` constructor takes a config object so tests
  can override log path, max bytes, max sessions, size-check
  throttle, idle flush, new-session rate cap, and ASN lookup.
- `server/sessionLog.js` no longer disables itself on the first
  ENOENT from a `stat()` of the not-yet-flushed log file. ENOENT
  during rotation just means there's nothing to rotate yet; only
  real errors (EACCES, EPERM, etc.) disable.
- `server/gameShape.js` `GameShapeStreamer` constructor accepts
  `{ durationMs, intervalMs, minBytes, maxBytes }` overrides. Production
  defaults unchanged.
- `server/Dockerfile` and `package.json` files require Node 20+
  (was 18+); the test suite uses `node:test` mock-timer features
  introduced in Node 20.4.
- `server/docker-compose.yml` healthcheck now inspects the response
  bytes via `od | grep` rather than just discarding nc's output.
  The previous version returned exit 0 even when nothing answered,
  silently masking a hung server.

### Deprecated
- (none)

### Removed
- The "single client.js as a release artifact" idea floated in
  earlier design notes. `client.js` requires `../shared/*` so it
  cannot run alone; the release ships the tree as a tarball.

### Fixed
- (none — first release)

### Security
- Server applies `normalizeIp()` to incoming source addresses before
  keying the per-IP rate limiter, the ASN lookup, and the session
  log. With a v4-only deployment this is a no-op; it prevents a
  future dual-stack deployment from having the same client occupy
  two distinct rate-limit buckets depending on whether a packet
  arrived as v4 or as v4-mapped v6.
- Defensive hardening from a security review of the client:
  - `--real-server` now uses a strict host:port parser that supports
    bracketed IPv6 forms (e.g. `[2001:db8::1]:27015`) and rejects
    ambiguous unbracketed IPv6, missing port, non-numeric port, and
    out-of-range ports with specific error messages — replacing a
    naive `String.split(':')` that shattered on IPv6 literals and
    silently turned a missing port into NaN.
  - `--duration` is capped at 300 seconds. The sustained-test's
    sequence-number deduplication set previously grew without bound
    under absurd `--duration` values; the cap is well above any
    legitimate diagnostic use.

[Unreleased]: https://github.com/sdg-net/sdg-connection-test/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sdg-net/sdg-connection-test/releases/tag/v1.0.0
