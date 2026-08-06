'use strict';

/**
 * Length-prefixed frames over a stream, and the encryption that wraps them.
 *
 * The relay (Phase G) carries traffic between two machines over the internet.
 * It is a dumb pipe on purpose: it pairs two sockets and copies bytes, and it
 * must not be able to read or alter what it copies, because it is the one
 * part of this system that sits on someone else's computer.
 *
 * So every frame is sealed with AES-256-GCM under a key both peers derive
 * from the pairing code and the relay never sees. A compromised relay can
 * drop the connection — that is unavoidable for anything in the middle — but
 * it cannot read a photo, forge a request, or replay one from earlier.
 */

const crypto = require('crypto');

/** 4-byte big-endian length prefix. */
const HEADER_BYTES = 4;

/** Refuse anything absurd before allocating for it. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * Reassembles frames from a byte stream.
 *
 * TCP gives no message boundaries: one write can arrive as three reads, and
 * three writes as one. Everything that treats a chunk as a message works
 * perfectly on localhost and corrupts as soon as there is a real network in
 * the way, so this is written to be indifferent to how bytes arrive.
 */
class FrameReader {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }

  /** @returns {Buffer[]} whole frames now available */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    const out = [];
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break;
      const length = this.buffer.readUInt32BE(0);

      if (length > this.maxBytes) {
        throw new FrameError(`Frame of ${length} bytes is larger than the ${this.maxBytes} allowed`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;

      out.push(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return out;
  }
}

function encodeFrame(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) throw new FrameError('That frame is too large to send');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Both halves of a pairing derive the same keys from the same secret.
 *
 * Separate keys per direction so a frame the host sent can never be replayed
 * back at it as though the client had sent it.
 */
function deriveKeys(secret, salt = 'lanshare-tunnel-1') {
  const material = crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from(salt), Buffer.from('keys'), 64);
  const bytes = Buffer.from(material);
  return {
    hostToClient: bytes.subarray(0, 32),
    clientToHost: bytes.subarray(32, 64),
  };
}

/**
 * Seal one frame.
 *
 * The counter is authenticated but not secret, and it is what makes replay
 * detectable: the receiver refuses anything it has already seen or that
 * arrives out of order.
 */
function seal(key, counter, plaintext) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(0, 0);
  nonce.writeBigUInt64BE(BigInt(counter), 4);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const aad = Buffer.alloc(8);
  aad.writeBigUInt64BE(BigInt(counter), 0);
  cipher.setAAD(aad);

  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([aad, cipher.getAuthTag(), body]);
}

function open(key, sealed, expectedCounter = null) {
  if (sealed.length < 8 + 16) throw new FrameError('That frame is too short to be genuine');

  const aad = sealed.subarray(0, 8);
  const tag = sealed.subarray(8, 24);
  const body = sealed.subarray(24);
  const counter = Number(aad.readBigUInt64BE(0));

  if (expectedCounter !== null && counter !== expectedCounter) {
    // Out of order, repeated, or skipped — all of which mean something is
    // interfering, since the transport underneath is ordered and reliable.
    throw new FrameError('A frame arrived out of order, which should not happen');
  }

  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(0, 0);
  nonce.writeBigUInt64BE(BigInt(counter), 4);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  try {
    return { counter, plaintext: Buffer.concat([decipher.update(body), decipher.final()]) };
  } catch {
    throw new FrameError('That frame failed its authenticity check — it was altered in transit');
  }
}

module.exports = {
  FrameError,
  FrameReader,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  deriveKeys,
  seal,
  open,
};
