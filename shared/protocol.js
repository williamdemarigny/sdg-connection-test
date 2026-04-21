// shared/protocol.js
//
// Binary encoder/decoder for the SDG Connection Test probe protocol.
// Every byte layout here matches docs/PROTOCOL.md exactly. If you are
// auditing the tool, read this file alongside that doc.
//
// Zero dependencies. Used by both the client and the server so there is one
// place to verify.

'use strict';

const MAGIC = Buffer.from('SDGT', 'ascii');          // 0x53 0x44 0x47 0x54
const VERSION = 1;
const HEADER_SIZE = 36;

const TYPE = Object.freeze({
  PROBE:            1,  // client -> server
  REPLY:            2,  // server -> client
  STREAM_BEGIN:     3,  // client -> server
  STREAM_STOP:      4,  // client -> server
  STREAM_DATA:      5,  // server -> client
  STREAM_CHALLENGE: 6,  // server -> client (16-byte HMAC token in payload)
  STREAM_CONFIRM:   7,  // client -> server (echoes token from CHALLENGE)
  RATE_LIMITED:     8,  // server -> client, always 36 bytes (non-amplifying)
});

// Offset at which the 16-byte stream challenge token lives in
// STREAM_CHALLENGE and STREAM_CONFIRM packets — the start of the payload
// area, immediately after the fixed 36-byte header.
const TOKEN_OFFSET = 36;
const TOKEN_SIZE = 16;

// Build a packet with the given fields and an optional total payload size
// in bytes (must be >= HEADER_SIZE). The area from offset 36 to totalSize
// is zero-padded.
function encode({ type, nonce, sequence, clientTsNs = 0n, serverTsNs = 0n, totalSize = HEADER_SIZE }) {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 8) {
    throw new Error('nonce must be an 8-byte Buffer');
  }
  if (totalSize < HEADER_SIZE) {
    throw new Error(`totalSize must be >= ${HEADER_SIZE}`);
  }
  const buf = Buffer.alloc(totalSize);                   // zero-filled
  MAGIC.copy(buf, 0);
  buf[4] = VERSION;
  buf[5] = type;
  // bytes 6..7 are reserved and already zero
  nonce.copy(buf, 8);
  buf.writeUInt32LE(sequence >>> 0, 16);
  buf.writeBigUInt64LE(BigInt(clientTsNs), 20);
  buf.writeBigUInt64LE(BigInt(serverTsNs), 28);
  // bytes 36..totalSize are zero padding (already zero from Buffer.alloc)
  return buf;
}

// Parse a buffer. Returns an object or null if the buffer is not a valid
// SDGT packet. Never throws.
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) return null;
  if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] ||
      buf[2] !== MAGIC[2] || buf[3] !== MAGIC[3]) return null;
  if (buf[4] !== VERSION) return null;
  return {
    type:        buf[5],
    nonce:       buf.subarray(8, 16),
    sequence:    buf.readUInt32LE(16),
    clientTsNs:  buf.readBigUInt64LE(20),
    serverTsNs:  buf.readBigUInt64LE(28),
    totalSize:   buf.length,
  };
}

// Quick check used by the server's handler chain before we pay the decode
// cost: does this look like a SDGT packet at all?
function looksLikeSdgt(buf) {
  return Buffer.isBuffer(buf) && buf.length >= HEADER_SIZE &&
         buf[0] === MAGIC[0] && buf[1] === MAGIC[1] &&
         buf[2] === MAGIC[2] && buf[3] === MAGIC[3];
}

module.exports = {
  MAGIC, VERSION, HEADER_SIZE, TYPE,
  TOKEN_OFFSET, TOKEN_SIZE,
  encode, decode, looksLikeSdgt,
};
