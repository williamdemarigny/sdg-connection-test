'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../client');

// Suppress the client's "Unknown argument" stderr noise during tests where
// we deliberately exercise the error path.
const origErr = console.error;
function mute(fn) {
  return function (...args) {
    console.error = () => {};
    try { return fn(...args); } finally { console.error = origErr; }
  };
}

test('defaults: no flags → host=null, sustained=true, a2s=true, family=auto', () => {
  const o = parseArgs([]);
  assert.equal(o.host, null);
  assert.equal(o.sustained, true);
  assert.equal(o.a2s, true);
  assert.equal(o.realServer, null);
  assert.equal(o.json, null);
  assert.equal(o.yes, false);
  assert.equal(o.family, 0, 'family 0 = OS auto by default');
  assert.equal(o.duration, 10_000, 'default sustained test duration is 10s');
  assert.equal(o.help, false);
});

test('--host captures the next argv', () => {
  const o = parseArgs(['--host', 'test.example.com']);
  assert.equal(o.host, 'test.example.com');
});

test('--ports parses comma-separated list with whitespace tolerance', () => {
  const o = parseArgs(['--ports', '27015, 27016 , 27017']);
  assert.deepEqual(o.ports, ['27015', '27016', '27017']);
});

test('--no-sustained / --no-a2s flip booleans', () => {
  const o = parseArgs(['--no-sustained', '--no-a2s']);
  assert.equal(o.sustained, false);
  assert.equal(o.a2s, false);
});

test('--real-server captures the host:port string verbatim', () => {
  const o = parseArgs(['--real-server', 'torch.example.com:27015']);
  assert.equal(o.realServer, 'torch.example.com:27015');
});

test('--json captures the file path', () => {
  const o = parseArgs(['--json', 'report.json']);
  assert.equal(o.json, 'report.json');
});

test('--yes and -y both set yes=true', () => {
  assert.equal(parseArgs(['--yes']).yes, true);
  assert.equal(parseArgs(['-y']).yes, true);
});

test('--help and -h both set help=true', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('--duration converts seconds to milliseconds', () => {
  assert.equal(parseArgs(['--duration', '5']).duration, 5000);
  assert.equal(parseArgs(['--duration', '0.5']).duration, 500);
});

test('--family 4 / 6 / auto / ipv4 / ipv6 / 0 are all accepted', () => {
  assert.equal(parseArgs(['--family', '4']).family, 4);
  assert.equal(parseArgs(['--family', '6']).family, 6);
  assert.equal(parseArgs(['--family', 'auto']).family, 0);
  assert.equal(parseArgs(['--family', 'ipv4']).family, 4);
  assert.equal(parseArgs(['--family', 'ipv6']).family, 6);
  assert.equal(parseArgs(['--family', '0']).family, 0);
});

test('--family with bogus value sets help=true (refuses to silently default)', mute(() => {
  const o = parseArgs(['--family', 'bogus']);
  assert.equal(o.help, true);
}));

test('unknown argument sets help=true', mute(() => {
  const o = parseArgs(['--definitely-not-a-flag']);
  assert.equal(o.help, true);
}));

test('combined flags compose correctly', () => {
  const o = parseArgs([
    '--host', 'a.b.c', '--no-a2s', '--family', '4',
    '--ports', '27015,27016', '--json', 'r.json', '--yes',
    '--real-server', 'r.example:27015', '--duration', '30',
  ]);
  assert.equal(o.host, 'a.b.c');
  assert.equal(o.a2s, false);
  assert.equal(o.family, 4);
  assert.deepEqual(o.ports, ['27015', '27016']);
  assert.equal(o.json, 'r.json');
  assert.equal(o.yes, true);
  assert.equal(o.realServer, 'r.example:27015');
  assert.equal(o.duration, 30_000);
});

test('order independence: --host first vs last is the same', () => {
  const a = parseArgs(['--host', 'x', '--yes']);
  const b = parseArgs(['--yes', '--host', 'x']);
  assert.deepEqual(a, b);
});

// --duration accepts up to 300 s; longer runs are rejected because the
// client accumulates sequence numbers in a per-test Set and absurd
// durations grow that without bound. 300 s × 60 pps = 18000 entries —
// well under any reasonable resource concern.
test('--duration accepts a positive value at the cap', mute(() => {
  const o = parseArgs(['--duration', '300']);
  assert.equal(o.duration, 300_000);
  assert.equal(o.help, false);
}));

test('--duration rejects values over the 300 s cap', mute(() => {
  const o = parseArgs(['--duration', '600']);
  assert.equal(o.help, true, 'over-cap duration sets help=true so usage prints');
}));

test('--duration rejects zero', mute(() => {
  const o = parseArgs(['--duration', '0']);
  assert.equal(o.help, true);
}));

test('--duration rejects negative', mute(() => {
  const o = parseArgs(['--duration', '-5']);
  assert.equal(o.help, true);
}));

test('--duration rejects non-numeric', mute(() => {
  const o = parseArgs(['--duration', 'forever']);
  assert.equal(o.help, true);
}));
