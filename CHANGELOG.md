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

(no changes since v1.0.0)

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

[Unreleased]: https://github.com/williamdemarigny/sdg-connection-test/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/williamdemarigny/sdg-connection-test/releases/tag/v1.0.0
