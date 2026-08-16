'use strict';

/**
 * The LANShare relay.
 *
 *   node relay/server.js [--port 8460]
 *
 * ## Why anything in the middle is needed at all
 *
 * Two machines behind home routers cannot introduce themselves to each other:
 * neither has an address the other can dial, and nothing arrives at either
 * without port forwarding. Something with a public address has to be in the
 * middle. That is not a design choice, it is how NAT works — the only real
 * question is how small and how trusted that middle thing has to be.
 *
 * This one is as small and as untrusted as it can be. It:
 *
 *   - accepts two outbound connections that name the same room,
 *   - copies bytes between them,
 *   - and understands nothing else.
 *
 * It never sees a password, a photo, a filename or a request. Every frame is
 * sealed with AES-256-GCM under a key derived from the pairing code, which is
 * exchanged out of band and never sent here. A relay operator — including a
 * hostile one who has taken the machine — can cut a connection off, and can
 * see that two peers are talking and roughly how much. It cannot read or
 * change a single byte of it.
 *
 * Run it on any cheap VPS or free tier. One process, no database, no state on
 * disk, nothing to back up.
 *
 * ## What it deliberately does not do
 *
 * No accounts, no TLS of its own (the payload is already end-to-end
 * encrypted, and adding a certificate to manage would be the largest source
 * of operational pain for no security gain), and no attempt at NAT hole
 * punching. Hole punching would let peers talk directly and drop the relay
 * out of the path, which is faster — but it needs a WebRTC stack, it fails
 * outright on symmetric NAT, and a relay is required as the fallback anyway.
 * Building the fallback first means the feature works everywhere; direct
 * connections can be added later as an optimisation without changing any of
 * the protocol above this line.
 *
 * ## The one exception to "no state on disk" (Phase J)
 *
 * Alongside the pairing pipe above, this process also answers a second,
 * unrelated kind of request: PUT and GET on an opaque encrypted blob, keyed
 * by an opaque string. This is what "a central index every device can
 * reach" (lib/central-index.js) is stored in — every device with the same
 * shared passphrase can find the same key, and every blob is ciphertext this
 * process never has the key to open. That does mean this process now keeps
 * something on disk after all, which the paragraph above used to claim it
 * never would. It is a deliberate, narrow exception: a handful of small
 * files, one per device that has ever published, nothing that grows
 * unboundedly, and still nothing this process can read. Access control is
 * the same as a pairing room's: nothing here checks who is asking, because
 * a storage key derived from a real passphrase is not something a stranger
 * can guess, the same way a room id derived from a pairing code is not.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { FrameReader, encodeFrame } = require('../lib/frames.js');

const DEFAULT_PORT = 8460;

/** How long a peer may wait alone in a room before being dropped. */
const LONELY_MS = 120_000;

/** A room id is opaque to us, but it should look like one. */
const ROOM_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const MAX_ROOMS = 500;

/** A storage key is opaque to us too — same shape as a room id, different namespace. */
const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** Generous for a compressed, encrypted index of even a very large library. */
const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Bounds total disk use from a relay shared by more than one household. */
const MAX_STORE_KEYS = 2000;

function createRelay({ log = console.log, storeDir = path.join(__dirname, 'store') } = {}) {
  /** room id -> { host, client } */
  const rooms = new Map();

  /** Safe by construction: every key is validated against STORE_KEY_PATTERN
   * before it is ever used to build a path, so this is never anything but
   * "<storeDir>/<the validated key>.blob". */
  function blobPath(key) {
    return path.join(storeDir, `${key}.blob`);
  }

  function countStoredKeys() {
    try {
      return fs.readdirSync(storeDir).length;
    } catch {
      return 0;
    }
  }

  function putBlob(key, blob) {
    if (blob.length > MAX_BLOB_BYTES) return { ok: false, error: 'blob is too large' };
    const already = fs.existsSync(blobPath(key));
    if (!already && countStoredKeys() >= MAX_STORE_KEYS) {
      return { ok: false, error: 'relay storage is full' };
    }
    fs.mkdirSync(storeDir, { recursive: true });
    // Written beside and renamed, so a publish that dies mid-write never
    // leaves a half blob where a device expects a whole one.
    const tmp = `${blobPath(key)}.part-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, blobPath(key));
    return { ok: true };
  }

  function getBlob(key) {
    try {
      const blob = fs.readFileSync(blobPath(key));
      const storedAt = fs.statSync(blobPath(key)).mtime.toISOString();
      return { ok: true, blob: blob.toString('base64'), storedAt };
    } catch {
      return { ok: true, blob: null };
    }
  }

  /**
   * Say no and hang up.
   *
   * `end` rather than `destroy` so the reason actually reaches the other side
   * — destroy discards anything still in the write buffer, which would leave
   * the peer with a bare disconnect and no idea why.
   */
  function refuse(socket, reason) {
    try {
      socket.end(encodeFrame(JSON.stringify({ ok: false, error: reason })));
    } catch {
      socket.destroy();
    }
  }

  function closeRoom(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room) return;
    rooms.delete(roomId);
    for (const socket of [room.host, room.client]) {
      if (socket && !socket.destroyed) socket.destroy();
    }
    log(`room ${roomId.slice(0, 8)}… closed (${reason})`);
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    let roomId = null;
    let role = null;
    const reader = new FrameReader();

    // Held on the socket rather than in this closure, because pairing is
    // completed by whichever peer arrives *second* and both sockets have to
    // learn about it. As a local, only the second arrival would ever see it,
    // and the first would go on treating real traffic as a hello and hang up.
    socket.paired = false;

    // A connection that never says who it is must not sit here forever.
    const lonely = setTimeout(() => {
      if (!socket.paired) socket.destroy();
    }, LONELY_MS);

    socket.on('data', (chunk) => {
      // Once paired, this is a pipe. Do not parse, do not buffer, just copy —
      // parsing traffic we cannot read would be pure risk for no benefit.
      if (socket.paired) {
        const other = rooms.get(roomId)?.[role === 'host' ? 'client' : 'host'];
        if (other && !other.destroyed) {
          if (!other.write(chunk)) socket.pause();
        }
        return;
      }

      let frames;
      try {
        frames = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        let hello;
        try {
          hello = JSON.parse(frame.toString('utf8'));
        } catch {
          socket.destroy();
          return;
        }

        // A store request is one-shot and unrelated to pairing: answered
        // and closed here, never touching `rooms` at all.
        if (hello.type === 'store') {
          if (!STORE_KEY_PATTERN.test(hello.key || '') || !['put', 'get'].includes(hello.action)) {
            refuse(socket, 'bad hello');
            return;
          }
          // Buffer.from(str, 'base64') never throws — invalid characters are
          // simply skipped, not rejected — so there is no decode error to
          // catch here. That is fine: the content is opaque ciphertext to
          // this process either way, and a caller who sends nonsense only
          // ever wastes its own storage slot, never anyone else's.
          const result = hello.action === 'get'
            ? getBlob(hello.key)
            : putBlob(hello.key, Buffer.from(hello.blob || '', 'base64'));
          try {
            socket.end(encodeFrame(JSON.stringify(result)));
          } catch {
            socket.destroy();
          }
          return;
        }

        // Nothing is recorded against this socket until the join is accepted.
        // Assigning roomId first meant a refused impostor's own disconnect
        // then tore down the room it had just been refused entry to — so
        // anyone who learned a room id could cut a live session off.
        const wantedRoom = hello.room;
        const wantedRole = hello.role;

        if (!ROOM_PATTERN.test(wantedRoom || '') || !['host', 'client'].includes(wantedRole)) {
          refuse(socket, 'bad hello');
          return;
        }

        if (!rooms.has(wantedRoom) && rooms.size >= MAX_ROOMS) {
          refuse(socket, 'relay is full');
          return;
        }

        const room = rooms.get(wantedRoom) || {};

        if (room[wantedRole] && !room[wantedRole].destroyed) {
          // Someone is already here in this role. Refusing rather than
          // replacing means a stale connection cannot evict a live one.
          refuse(socket, 'that role is taken');
          return;
        }

        roomId = wantedRoom;
        role = wantedRole;
        room[role] = socket;
        rooms.set(roomId, room);

        if (room.host && room.client) {
          clearTimeout(lonely);
          const ready = encodeFrame(JSON.stringify({ ok: true, paired: true }));
          // Both sockets are told, and both are marked — see the note above.
          for (const peer of [room.host, room.client]) {
            peer.paired = true;
            peer.write(ready);
          }
          log(`room ${roomId.slice(0, 8)}… paired`);
        } else {
          socket.write(encodeFrame(JSON.stringify({ ok: true, paired: false })));
        }
      }
    });

    socket.on('drain', () => {
      const other = rooms.get(roomId)?.[role === 'host' ? 'client' : 'host'];
      if (other && !other.destroyed) other.resume();
    });

    const goodbye = () => {
      clearTimeout(lonely);
      if (roomId) closeRoom(roomId, `${role} disconnected`);
    };
    socket.on('close', goodbye);
    socket.on('error', goodbye);
  });

  return {
    server,
    rooms,
    listen(port = DEFAULT_PORT, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          log(`LANShare relay listening on ${host}:${port}`);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const roomId of [...rooms.keys()]) closeRoom(roomId, 'relay shutting down');
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : DEFAULT_PORT;
  const storeDirArg = process.argv.indexOf('--store-dir');
  const storeDir = storeDirArg > -1 ? process.argv[storeDirArg + 1] : undefined;

  const relay = createRelay(storeDir ? { storeDir } : {});
  relay.listen(port).catch((err) => {
    console.error(`Could not start the relay: ${err.message}`);
    process.exit(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => relay.close().then(() => process.exit(0)));
  }
}

module.exports = {
  createRelay, DEFAULT_PORT, LONELY_MS, MAX_ROOMS, STORE_KEY_PATTERN, MAX_BLOB_BYTES, MAX_STORE_KEYS,
};
