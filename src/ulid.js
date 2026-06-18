'use strict';
// Minimal local ULID generator — no external dependency.
//
// ULID = 48-bit millisecond timestamp + 80 bits of randomness, encoded in
// Crockford base32 (26 chars total). It's time-sortable (lexical order
// matches creation order at ms granularity) and offline-mintable (no
// central coordinator), which is exactly what shared-write needs: two
// machines mint ids with zero coordination and the ids still sort by time.
//
// We roll our own (vs adding the `ulid` npm package) because the design
// doc says keep deps minimal and a tiny well-understood helper is ETC
// ("easier to change") than a transitive dependency.

const crypto = require('crypto');

// Crockford base32 alphabet (excludes I, L, O, U to avoid ambiguity).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10; // 48 bits -> 10 base32 chars
const RANDOM_LEN = 16; // 80 bits -> 16 base32 chars

function encodeTime(now, len) {
  // Encode a millisecond timestamp into `len` base32 chars, most
  // significant char first, so lexical order == chronological order.
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING[mod] + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(len) {
  // 5 random bits per char. Use crypto for collision safety.
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return out;
}

function ulid(now = Date.now()) {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN);
}

module.exports = { ulid };
