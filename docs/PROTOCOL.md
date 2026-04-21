# SDG Connection Test — Wire Protocol

This file documents **every byte** the client sends and the server sends back.
If you are a player auditing the client before running it, start here. Then
read [TRANSPARENCY.md](./TRANSPARENCY.md) for hex-dump examples you can verify
in Wireshark.

Two protocols travel over the test ports:

1. The **SDG Connection Test probe protocol** (our own, tiny, binary).
2. The **Steam A2S query protocol** (Valve's public Source query protocol)
   on UDP port 27015 only.

Nothing else is sent or accepted. No hostnames, no usernames, no game files,
no environment variables, no telemetry.

---

## 1. SDG Connection Test probe protocol (SDGT)

All SDG-CT packets share a fixed 36-byte header and an optional zero-padding
tail. Endian: **little-endian** everywhere. All multi-byte fields are unsigned.

```
Offset  Size  Field              Description
------  ----  -----------------  --------------------------------------------
0       4     magic              ASCII 'SDGT'  =  0x53 0x44 0x47 0x54
4       1     version            = 1
5       1     type               1 = probe            (client -> server)
                                 2 = reply            (server -> client)
                                 3 = stream_begin     (client -> server)
                                 4 = stream_stop      (client -> server)
                                 5 = stream_data      (server -> client)
                                 6 = stream_challenge (server -> client, 16-byte token at offset 36)
                                 7 = stream_confirm   (client -> server, echoes challenge token)
                                 8 = rate_limited     (server -> client, always exactly 36 bytes)
6       2     reserved           = 0x00 0x00
8       8     session_nonce      8 random bytes generated once per client run.
                                 Printed by the client at startup so the
                                 player can match it against outbound traffic
                                 in Wireshark.
16      4     sequence           Monotonic per (proto, port) test, starting at 0.
20      8     client_ts_ns       Client send timestamp, nanoseconds since
                                 process start (Node process.hrtime.bigint()).
                                 Used by the client to compute RTT when the
                                 reply comes back; the server does not
                                 interpret this value.
28      8     server_ts_ns       Zero on probe.
                                 On reply, the server stamps its own
                                 process.hrtime.bigint() value here purely
                                 as a liveness indicator. Not a wall clock.
36      N     payload / padding  For type 1/2/8 and stream_data: zero padding
                                 (0..~1400 bytes). For type 6/7: a 16-byte
                                 HMAC challenge token. Never contains any
                                 data derived from the host.
```

### RATE_LIMITED (type 8)

Sent by the server when a source IP or the global bucket is empty. The
packet is exactly HEADER_SIZE bytes (36), which is strictly smaller than
any probe the client might have sent (up to 1400 bytes on the MTU
test). This is intentional: a rate-limit response must be
**de-amplifying** so that rate limiting itself cannot be abused as a
reflection vector. The nonce and sequence fields echo the original
probe so the client can match the response to a specific in-flight
test rather than confusing it with ISP packet loss.

### STREAM_CHALLENGE (type 6) and STREAM_CONFIRM (type 7)

Before the server will start a game-shape traffic stream on UDP 27016
(which would otherwise be a large outbound amplifier) it requires proof
that the client can actually receive packets at the source address it
claims. The handshake is:

1. Client sends `STREAM_BEGIN` (type 3, 36 bytes).
2. Server replies with `STREAM_CHALLENGE` (type 6) containing a 16-byte
   HMAC token at offset 36. The token is
   `HMAC-SHA256(secret, "stream" || ip || port || nonce || bucket)`
   truncated to 16 bytes, where `bucket = floor(now / 30_000)` and
   `secret` is 32 random bytes generated at server start (never
   persisted). Valid for the current and previous time bucket
   (30-60 seconds).
3. Client sends `STREAM_CONFIRM` (type 7) echoing the same 16-byte
   token at offset 36.
4. Server verifies the token; if valid AND the per-IP/global stream
   concurrency caps allow it, the 10-second stream of `STREAM_DATA`
   packets begins.

A spoofed source address never sees step 2 and therefore cannot forge
step 3, so the stream never starts for traffic that was not actually
solicited by the source host.

**TCP framing.** TCP is a stream, so a TCP probe frame is prefixed with a
2-byte little-endian length field giving the number of bytes in the SDG-CT
packet that follows. That is the only difference.

**Reply rule.** The server forms a reply by taking the probe packet verbatim,
rewriting `type` from `1` to `2`, writing its own `server_ts_ns`, and
sending it back to the source address. Padding is preserved byte-for-byte.

---

## 2. Game-shape sustained test

Used only on UDP port 27016, only when the client explicitly opts in.

1. Client sends a single `type = 3` (stream_begin) probe to `udp:27016`.
2. Server begins emitting `type = 5` (stream_data) packets to the client's
   source address at approximately 60 packets per second for 10 seconds.
   Each stream_data packet has a random payload length between 200 and 400
   bytes; the payload is zero-padded (no random bytes, so a capture is still
   trivially identifiable).
3. Client counts received packets, computes loss %, inter-arrival jitter,
   and any gap > 250 ms.
4. Server stops automatically after 10 seconds. Client may also send a
   `type = 4` (stream_stop) to end early.

Rate, duration, and payload sizes are all intentionally close to real Space
Engineers gameplay traffic so that any ISP DPI or shaping logic that keys on
"sustained medium-rate UDP flow on 27016" will see roughly the same
fingerprint.

We do **not** implement the real SteamNetworkingSockets handshake. See
[TRANSPARENCY.md](./TRANSPARENCY.md) for why.

---

## 3. Steam A2S query (UDP 27015 only)

This is the public Source Engine query protocol documented by Valve at
<https://developer.valvesoftware.com/wiki/Server_queries>. We implement
`A2S_INFO` with the December 2020 challenge requirement that Valve
added specifically to block reflected-amplification DDoS abuse.

**Step 1 — Request** (client -> server, 25 bytes):

```
FF FF FF FF 54 "Source Engine Query\0"
```

**Step 2 — Challenge reply** (server -> client, 9 bytes):

```
FF FF FF FF 41 <u32 challenge>
```

This reply is *smaller* than the request, so it is non-amplifying by
construction. The 4-byte challenge is
`HMAC-SHA256(secret, "a2s" || ip || bucket)` truncated to uint32,
identical in spirit to the STREAM_CHALLENGE HMAC above.

**Step 3 — Request with challenge** (client -> server, 29 bytes):

```
FF FF FF FF 54 "Source Engine Query\0" <u32 challenge>
```

**Step 4 — Info reply** (server -> client, ~120 bytes): a packed
binary reply beginning with the four-byte header `FF FF FF FF 49`,
followed by protocol version, server name, map, folder, game, Steam
AppID, player counts, bot count, server type, environment, visibility,
VAC, version, and extra data flags. Only sent after a valid challenge
is received, which bounds amplification at zero. Our test server
returns fabricated but well-formed values:

| Field         | Value                  |
| ------------- | ---------------------- |
| name          | `SDG Connection Test`  |
| map           | `diagnostic`           |
| folder        | `sdg`                  |
| game          | `SDG Connection Test`  |
| app id        | 0                      |
| players       | 0                      |
| max players   | 32                     |
| bots          | 0                      |
| server type   | `d` (dedicated)        |
| environment   | `l` (Linux)            |
| visibility    | 0 (public)             |
| VAC           | 0 (insecure)           |
| version       | `1.0.0`                |

A real Steam master server browser will list the test server with the name
"SDG Connection Test". This is intentional: it confirms the UDP path from the
Steam backbone to the test server is clean.

---

## What is NOT in any packet

The following are **never** sent by the client, under any circumstance:

- The player's username, computer name, or OS user.
- Environment variables.
- File paths, directory listings, or file contents.
- Any field derived from the Steam install.
- Any network interface names or MAC addresses.
- Any information about other processes running on the machine.
- Any string representation of the target host beyond the single `--host`
  argument the player typed on the command line (and that only goes inside
  outbound DNS / TCP / UDP headers, never inside a payload).

You can confirm all of this with:

```
wireshark -i <your NIC> -f "host <test-server>"
```

and cross-checking every byte of every outbound packet against the layout
above.
