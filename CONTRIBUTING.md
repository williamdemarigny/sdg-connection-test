# Contributing

Thanks for considering a contribution. This is a small, focused project
with a hard "no dependencies" rule and a strong preference for simple,
auditable code over abstraction. Read this whole file before opening a PR.

## Acceptable use

This is a **diagnostic tool for your own networks and servers**. The
client supports a `--real-server` flag that lets it send a Steam
A2S_INFO query to any UDP host you point it at; that exists so you can
compare what the SDG diagnostic server sees with what your actual Torch
server sees. It is NOT a general-purpose probe-anyone tool. PRs and
issues that frame the project as a reconnaissance tool, or that add
features primarily useful for unauthorized scanning, will be closed.

If you don't operate it and you don't have explicit permission to probe
it, leave it alone.

## Hard rule: no npm dependencies

Both runtime and development. The client is a single file you can read
end-to-end in fifteen minutes; the server is a handful of small files
and a `node_modules` directory full of transitive packages would
undermine that audit story for everyone.

CI enforces this in
[`.github/workflows/sdg-connection-test-ci.yml`](../.github/workflows/sdg-connection-test-ci.yml)
via a `zero-dep-guard` job:

- Every `package.json` must have empty (or absent) `dependencies`,
  `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- `client/client.js` must `require()` only Node built-ins and
  `../shared/*`.
- `client/` must contain exactly one non-test JS file.
- `server/server.js` must `require()` only Node built-ins, `./*` (its
  own peers), and `../shared/*`.

A PR that fails any of those guards will not merge.

If you find yourself wanting a library, the right move is usually
either:

1. Inline the 30 lines from the library that you actually need, or
2. Decide you don't need them.

We use Node 20+ specifically so that `node:test`, `node:assert/strict`,
and the built-in test runner cover what people would otherwise reach
for Jest / Mocha / Vitest for.

## Repo layout

```
SDG-Connection-Test/
  shared/                shared modules + tests (used by both server and client)
  server/                hardened TCP/UDP echo + A2S responder + session log
  client/                zero-dep diagnostic client (single file, single file, single file)
  docs/                  PROTOCOL, TRANSPARENCY, SECURITY, PRIVACY, DEPLOY,
                         FIELD-TEST-PROTOCOL, FIELD-RESULTS
  LICENSE                MIT
  CONTRIBUTING.md        this file
  CHANGELOG.md           Keep-a-Changelog format
```

Everything lives under `SDG-Connection-Test/` because the parent repo
(`SDG-DevOps`) hosts unrelated Terraform / Helm / Kubernetes work.

## Running tests

Each peer package is independently runnable:

```
cd shared && npm test
cd server && npm test
cd client && npm test
```

`npm test` is just `node --test` under the hood. There is no `npm
install` step. Total runtime is on the order of two seconds.

Coverage:

```
cd server && node --test --experimental-test-coverage
```

The flag has known false-low readings (it counts test files themselves;
it cannot exclude). Don't gate PRs on a percentage — read the report.

## Adding a port to `shared/ports.js`

The port matrix is the single source of truth for both client and
server. To add an entry:

1. Append it to `PORTS` in [`shared/ports.js`](shared/ports.js) with the
   correct `proto`, `port`, `category`, and `purpose`.
2. Update `shared/test/ports.test.js` if your addition affects any of
   the structural invariants (e.g. you added a new `category` value).
3. Update [`docs/DEPLOY.md`](docs/DEPLOY.md) §5 (upstream firewall
   table) AND §3 (host ufw block on the VM) so deployers see the new
   port immediately.
4. Update [`docs/SECURITY.md`](docs/SECURITY.md) only if the new port
   has hardening implications (e.g. it speaks a non-trivial protocol or
   exposes a new amplifier).

Server side: every new UDP port gets the default echo handler unless it
is special-cased like UDP 27015 (A2S) or UDP 27016 (game-shape). If
your port needs special handling, add a peer module in `server/` and
wire it up in `handleUdpMessage` in
[`server/server.js`](server/server.js). Keep the dispatch in `server.js`
flat and readable.

## Coding style

- 2-space indent, semicolons, single-quoted strings.
- `'use strict';` at the top of every file.
- No transpilers. Run on the Node version we ship in CI (currently 20+).
- Functions over classes unless lifecycle / state really wants a class.
- File length stays under ~400 lines. If a file is growing past that,
  extract a peer module. The existing files were chosen at sizes the
  reader can hold in their head.
- No comments that re-state the code. Comments explain the *why* —
  protocol references, threat-model rationale, surprising invariants.
  The existing files are the style guide.

## Pull requests

1. Open an issue first if the change is non-trivial. A quick sanity
   check on direction saves both sides time.
2. Branch off `main`. Keep the diff focused — one PR, one concern.
3. Update tests to cover behavior you change. We aim for: 80% on
   `shared/`, 70% on `server/`, ~50% on `client/` (CLI orchestration is
   covered by integration; pure functions are covered by units).
4. Update relevant docs in the same PR. A code change that contradicts
   `PROTOCOL.md` or `SECURITY.md` is not done until those docs are
   updated.
5. Don't add a `CHANGELOG.md` entry yourself; maintainers add the entry
   when cutting a release so the format stays consistent.
6. CI must be green. The `zero-dep-guard` job in particular is
   load-bearing for the project's identity — its failure is the only
   thing that consistently means "do not merge."

## Releases

Maintainers cut releases. The process is documented elsewhere; users
should not need to know it. From a contributor's perspective, what
matters is that breaking changes to the wire protocol bump the
`VERSION` byte in [`shared/protocol.js`](shared/protocol.js), which is
also the point at which we cut a major SemVer tag.

## Questions

Open an issue in the parent repo (`SDG-DevOps`). Tag it `connection-test`.
