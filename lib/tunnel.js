'use strict';

/**
 * Reaching a LANShare host over the internet, through a relay.
 *
 * Both machines make an **outbound** connection to the relay, which is why
 * this needs no port forwarding on either end: routers allow outbound
 * connections and always have.
 *
 * The host end takes a tunnelled request, replays it against its own server
 * on localhost, and sends the answer back. That is deliberately how it works
 * rather than injecting into Express directly: every route, every permission
 * check, every vault rule and every audit already applies to an ordinary HTTP
 * request, and a second path into the app would be a second place for all of
 * that to be got wrong.
 *
 * Everything crossing the relay is sealed with AES-256-GCM under a key both
 * ends derive from the pairing code. See lib/frames.js.
 */

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

const frames = require('./frames.js');

class TunnelError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TunnelError';
    this.status = status;
  }
}

/** Crockford base32 — no I, L, O or U, so it survives being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  const clean = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '')
    // Crockford: these are commonly mistyped for digits, so accept them.
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');

  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new TunnelError('That pairing code has a character that is not part of one');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A pairing code carries everything the far end needs: which room to meet in
 * and the key to talk with. It is therefore **as sensitive as a password** —
 * anyone holding it can reach the library that issued it, which is why the UI
 * says so at the moment of sharing.
 */
function createPairing() {
  const secret = crypto.randomBytes(20);
  return {
    secret,
    code: formatCode(toBase32(secret)),
    room: roomFor(secret),
  };
}

function formatCode(raw) {
  return raw.match(/.{1,4}/g).join('-');
}

function parsePairing(code) {
  const secret = fromBase32(code);
  if (secret.length !== 20) {
    throw new TunnelError('That pairing code is not the right length');
  }
  return { secret, code: formatCode(toBase32(secret)), room: roomFor(secret) };
}

/**
 * The room name is derived from the secret, not equal to it.
 *
 * The relay sees room names. If the room *were* the secret, running the relay
 * would hand you the key to every library using it.
 */
function roomFor(secret) {
  return crypto.createHmac('sha256', 'lanshare-room-1').update(secret).digest('base64url').slice(0, 32);
}

/**
 * How much of a message goes in one frame.
 *
 * A video is an ordinary thing to have in a photo library, and one does not
 * fit in a single frame — so anything larger than this is split across several
 * and reassembled at the far end. Kept well under the 16 MB frame ceiling
 * because each part is base64 inside JSON, which inflates it by a third.
 */
const PART_BYTES = 3 * 1024 * 1024;

/**
 * The most a single message may reassemble to.
 *
 * The far end is authenticated, so this is not really a defence against an
 * attacker — it is a guard against one enormous file quietly exhausting
 * memory on whichever machine is smaller.
 */
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

/** One end of a relayed connection: framing, sealing and counters. */
class Channel extends EventEmitter {
  constructor({ socket, key, sendKey, recvKey }) {
    super();
    this.socket = socket;
    this.sendKey = sendKey || key;
    this.recvKey = recvKey || key;
    this.sendCounter = 0;
    this.recvCounter = 0;
    this.reader = new frames.FrameReader();
    this.nextPartId = 1;
    /** part id -> { parts, total, bytes } */
    this.partial = new Map();

    socket.on('data', (chunk) => {
      let incoming;
      try {
        incoming = this.reader.push(chunk);
      } catch (err) {
        this.emit('error', err);
        socket.destroy();
        return;
      }

      for (const frame of incoming) {
        try {
          const { plaintext } = frames.open(this.recvKey, frame, this.recvCounter);
          this.recvCounter++;
          const message = JSON.parse(plaintext.toString('utf8'));
          const whole = message.__part === undefined ? message : this.reassemble(message);
          if (whole) this.emit('message', whole);
        } catch (err) {
          // A frame that fails to authenticate means someone is interfering.
          // Tearing the connection down is the only safe response.
          this.emit('error', err);
          socket.destroy();
          return;
        }
      }
    });

    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => this.emit('error', err));
  }

  /** Collect a split message; returns it once every part has arrived. */
  reassemble({ __part: id, i, total, d }) {
    let entry = this.partial.get(id);
    if (!entry) {
      entry = { parts: new Array(total), have: 0, bytes: 0 };
      this.partial.set(id, entry);
    }

    if (entry.parts[i] === undefined) {
      const piece = Buffer.from(d, 'base64');
      entry.bytes += piece.length;
      if (entry.bytes > MAX_MESSAGE_BYTES) {
        this.partial.delete(id);
        throw new TunnelError('That file is too large to send over the internet connection', 413);
      }
      entry.parts[i] = piece;
      entry.have++;
    }

    if (entry.have < total) return null;
    this.partial.delete(id);
    return JSON.parse(Buffer.concat(entry.parts).toString('utf8'));
  }

  send(message) {
    if (this.socket.destroyed) throw new TunnelError('The connection to the other machine is closed', 503);

    const body = Buffer.from(JSON.stringify(message));
    if (body.length <= PART_BYTES) {
      this.write(body);
      return;
    }

    // A video does not fit in one frame. Splitting here rather than in the
    // request and response code means neither of those has to know that a
    // message can be larger than a frame.
    const id = this.nextPartId++;
    const total = Math.ceil(body.length / PART_BYTES);
    for (let i = 0; i < total; i++) {
      const slice = body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES);
      this.write(Buffer.from(JSON.stringify({
        __part: id, i, total, d: slice.toString('base64'),
      })));
    }
  }

  write(plaintext) {
    const sealed = frames.seal(this.sendKey, this.sendCounter++, plaintext);
    this.socket.write(frames.encodeFrame(sealed));
  }

  close() {
    if (!this.socket.destroyed) this.socket.destroy();
  }
}

/** Connect to the relay and wait to be paired with the other end. */
function joinRelay({ relayHost, relayPort, room, role, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: relayHost, port: relayPort });
    socket.setNoDelay(true);

    const reader = new frames.FrameReader();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TunnelError('The other machine did not join in time', 504));
    }, timeoutMs);

    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err instanceof TunnelError ? err : new TunnelError(
        `Could not reach the relay: ${err.message}`, 502,
      ));
    };

    socket.once('error', fail);

    socket.on('connect', () => {
      socket.write(frames.encodeFrame(JSON.stringify({ role, room })));
    });

    const onData = (chunk) => {
      let incoming;
      try {
        incoming = reader.push(chunk);
      } catch (err) {
        fail(err);
        return;
      }

      for (const frame of incoming) {
        let message;
        try {
          message = JSON.parse(frame.toString('utf8'));
        } catch {
          fail(new TunnelError('The relay said something unintelligible', 502));
          return;
        }

        if (!message.ok) {
          fail(new TunnelError(`The relay refused the connection: ${message.error}`, 502));
          return;
        }
        if (message.paired) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          socket.removeListener('error', fail);
          // Anything after the pairing notice is tunnel traffic. There should
          // be none yet, but if the relay coalesced writes it must not be lost.
          const leftover = reader.buffer;
          resolve({ socket, leftover });
          return;
        }
      }
    };

    socket.on('data', onData);
  });
}

/**
 * One PUT or GET against the relay's blob store (Phase J), used by
 * lib/central-index.js. Unlike joinRelay() above, this is not a pairing —
 * there is no second peer to wait for, just one request and one answer, so
 * the socket closes itself the moment the response frame arrives.
 */
function storeRequest({ relayHost, relayPort, action, key, blob, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: relayHost, port: relayPort });
    socket.setNoDelay(true);

    const reader = new frames.FrameReader();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TunnelError('The relay did not answer in time', 504));
    }, timeoutMs);

    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err instanceof TunnelError ? err : new TunnelError(`Could not reach the relay: ${err.message}`, 502));
    };

    socket.once('error', fail);

    socket.on('connect', () => {
      socket.write(frames.encodeFrame(JSON.stringify({ type: 'store', action, key, blob })));
    });

    socket.on('data', (chunk) => {
      let incoming;
      try {
        incoming = reader.push(chunk);
      } catch (err) {
        fail(err);
        return;
      }
      if (!incoming.length) return;

      clearTimeout(timer);
      let message;
      try {
        message = JSON.parse(incoming[0].toString('utf8'));
      } catch {
        fail(new TunnelError('The relay said something unintelligible', 502));
        return;
      }
      socket.destroy();
      if (!message.ok) {
        reject(new TunnelError(message.error || 'The relay refused that', 502));
        return;
      }
      resolve(message);
    });
  });
}

/**
 * The host end: answers tunnelled requests from its own local server.
 *
 * Reconnects when the relay drops, because the relay is the one part of this
 * that is expected to restart without warning.
 */
class TunnelHost extends EventEmitter {
  constructor({ relayHost, relayPort, pairing, localPort, log = null }) {
    super();
    this.relayHost = relayHost;
    this.relayPort = relayPort;
    this.pairing = pairing;
    this.localPort = localPort;
    this.log = log || (() => {});
    this.channel = null;
    this.stopped = false;
    this.retryMs = 2000;
  }

  /**
   * Begin waiting for a machine to call.
   *
   * Deliberately not awaited on the pairing: a host waits indefinitely for
   * someone to connect, so awaiting that here would mean the host cannot
   * finish starting until a client arrives — and a client cannot arrive
   * until the host has started.
   */
  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  async connect() {
    if (this.stopped) return;
    try {
      const { socket } = await joinRelay({
        relayHost: this.relayHost,
        relayPort: this.relayPort,
        room: this.pairing.room,
        role: 'host',
        // A host waits indefinitely for someone to call; it is the one
        // advertising itself.
        timeoutMs: 0x7fffffff,
      });

      const keys = frames.deriveKeys(this.pairing.secret);
      this.channel = new Channel({
        socket,
        sendKey: keys.hostToClient,
        recvKey: keys.clientToHost,
      });

      this.channel.on('message', (message) => this.handle(message));
      this.channel.on('error', (err) => this.log(`tunnel: ${err.message}`));
      this.channel.on('close', () => {
        this.channel = null;
        this.emit('disconnected');
        if (!this.stopped) setTimeout(() => this.connect(), this.retryMs);
      });

      this.emit('connected');
      this.log('tunnel: a machine connected through the relay');
    } catch (err) {
      this.log(`tunnel: ${err.message}`);
      if (!this.stopped) setTimeout(() => this.connect(), this.retryMs);
    }
  }

  /**
   * Replay a tunnelled request against the local server.
   *
   * Bound to 127.0.0.1 deliberately: the tunnel is not a way to reach
   * anything on this machine other than LANShare itself.
   */
  handle(message) {
    if (!message || message.type !== 'request' || !this.channel) return;

    const request = http.request({
      host: '127.0.0.1',
      port: this.localPort,
      method: message.method || 'GET',
      path: message.path || '/',
      headers: {
        ...(message.headers || {}),
        host: `127.0.0.1:${this.localPort}`,
        // Marks this as having come in over the internet. Everything through
        // the tunnel arrives from 127.0.0.1, which would otherwise make a
        // remote visitor indistinguishable from someone sitting at the
        // keyboard — both on the Devices screen and in the login throttle.
        // Only a request already reaching the loopback interface can set
        // this, and anyone who can do that is on the machine already.
        'x-lanshare-via': 'relay',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          this.channel?.send({
            type: 'response',
            id: message.id,
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('base64'),
          });
        } catch (err) {
          this.log(`tunnel: could not answer — ${err.message}`);
        }
      });
    });

    request.on('error', (err) => {
      try {
        this.channel?.send({
          type: 'response', id: message.id, status: 502, headers: {},
          body: Buffer.from(`The library on that machine did not answer: ${err.message}`).toString('base64'),
        });
      } catch { /* the tunnel went away too */ }
    });

    if (message.body) request.write(Buffer.from(message.body, 'base64'));
    request.end();
  }

  stop() {
    this.stopped = true;
    this.channel?.close();
    this.channel = null;
  }
}

/**
 * The client end.
 *
 * `call()` deliberately returns the same shape lib/remote.js does, so a host
 * reached over the internet and one on the LAN are the same thing to
 * everything above — including the Machines screen, which needs no idea which
 * it is talking to.
 */
class TunnelClient extends EventEmitter {
  constructor({ relayHost, relayPort, pairing, timeoutMs = 60000 }) {
    super();
    this.relayHost = relayHost;
    this.relayPort = relayPort;
    this.pairing = pairing;
    this.timeoutMs = timeoutMs;
    this.channel = null;
    this.pending = new Map();
    this.nextId = 1;
    this.cookie = null;
  }

  async connect() {
    const { socket } = await joinRelay({
      relayHost: this.relayHost,
      relayPort: this.relayPort,
      room: this.pairing.room,
      role: 'client',
    });

    const keys = frames.deriveKeys(this.pairing.secret);
    this.channel = new Channel({
      socket,
      sendKey: keys.clientToHost,
      recvKey: keys.hostToClient,
    });

    this.channel.on('message', (message) => {
      if (message.type !== 'response') return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      waiting.resolve({
        status: message.status,
        headers: message.headers || {},
        body: Buffer.from(message.body || '', 'base64'),
        setCookie: (message.headers?.['set-cookie']?.[0] || '').split(';')[0] || null,
      });
    });

    this.channel.on('close', () => {
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new TunnelError('The connection to the other machine closed', 503));
      }
      this.pending.clear();
      this.emit('close');
    });

    this.channel.on('error', (err) => this.emit('error', err));
    return this;
  }

  call(path, { method = 'GET', headers = {}, body = null, cookie = null } = {}) {
    if (!this.channel) throw new TunnelError('Not connected to that machine', 503);

    const id = this.nextId++;
    const outgoing = { ...headers };
    const useCookie = cookie ?? this.cookie;
    if (useCookie) outgoing.cookie = useCookie;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TunnelError('The other machine did not answer in time', 504));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (response) => {
          if (response.setCookie) this.cookie = response.setCookie;
          resolve(response);
        },
        reject,
        timer,
      });

      try {
        this.channel.send({
          type: 'request',
          id,
          method,
          path,
          headers: outgoing,
          body: body ? Buffer.from(body).toString('base64') : null,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  close() {
    this.channel?.close();
    this.channel = null;
  }
}

module.exports = {
  TunnelError,
  TunnelHost,
  TunnelClient,
  Channel,
  createPairing,
  parsePairing,
  roomFor,
  toBase32,
  fromBase32,
  formatCode,
  storeRequest,
};
