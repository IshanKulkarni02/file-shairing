'use strict';

/**
 * Finding other LANShare hosts on the same network.
 *
 * So that adding a machine means picking it from a list rather than knowing
 * its IP address, which changes.
 *
 * ## Why not mDNS
 *
 * The plan said mDNS, and mDNS is the right answer if you want to be
 * discoverable by *other* software — Finder, printers, generic service
 * browsers. Nothing here needs that: the only thing looking for a LANShare
 * host is another LANShare host. Getting mDNS is either a dependency carrying
 * a full DNS-SD stack, or several hundred lines of packet construction with
 * conflict resolution and cache-flush semantics to get subtly wrong.
 *
 * A single UDP multicast group does the same job in a fraction of the code,
 * with no dependency and identical behaviour on Windows, macOS and Linux. The
 * cost is that only LANShare can find LANShare, which is all that was needed.
 *
 * The app already publishes `hostname.local` through the OS's own responder,
 * so typing a name still works where this does not.
 *
 * ## What is broadcast
 *
 * Only what anyone on the network could learn by scanning it anyway: that
 * this is LANShare, its machine name, its ports, and a random per-install id
 * to tell two machines with the same name apart. **No library contents, no
 * account names, no paths, no certificate secrets.** Discovery gets you a
 * candidate address; it does not get you in — that still needs credentials
 * and, over HTTPS, a matching pinned certificate.
 */

const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

/* eslint-disable no-empty */

/** Administratively-scoped multicast: routers do not forward it off the LAN. */
const GROUP = '239.255.90.42';
const PORT = 8421;

const ANNOUNCE_MS = 10000;
/** Missing three announcements is enough to call a host gone. */
const STALE_MS = ANNOUNCE_MS * 3 + 2000;

const MAGIC = 'lanshare-discovery-1';

/** A stable id per install, so two machines called "MacBook Pro" are distinct. */
function installId(config) {
  if (!config.installId) config.installId = crypto.randomBytes(8).toString('hex');
  return config.installId;
}

class Discovery extends EventEmitter {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {boolean} [deps.announce]  false for a client that only listens
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ getConfig, announce = true, log = null, port = PORT, group = GROUP }) {
    super();
    this.getConfig = getConfig;
    this.announcing = announce;
    this.log = log || (() => {});
    this.port = port;
    this.group = group;

    this.socket = null;
    this.timer = null;
    /** id -> host record, most recent announcement wins. */
    this.hosts = new Map();
  }

  start() {
    if (this.socket) return;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      // A blocked multicast port is a normal outcome on a locked-down network.
      // Discovery is a convenience; adding a host by address must keep working.
      this.log(`discovery unavailable: ${err.message}`);
      this.stop();
    });

    socket.on('message', (buffer, rinfo) => this.receive(buffer, rinfo));

    socket.bind(this.port, () => {
      const joined = this.join(socket);
      if (!joined) {
        this.log('could not join the discovery group on any interface');
        this.stop();
        return;
      }

      // Ask who is out there, so a newly started app does not wait up to ten
      // seconds for everyone else's next announcement. Carries our own id so
      // that we do not answer the copy of it the stack loops back to us.
      this.send({ type: 'query', id: installId(this.getConfig() || {}) });
      if (this.announcing) this.announce();

      this.timer = setInterval(() => {
        if (this.announcing) this.announce();
        this.expire();
      }, ANNOUNCE_MS);
      if (this.timer.unref) this.timer.unref();
    });
  }

  /**
   * Join the multicast group on every interface, not just the default one.
   *
   * `addMembership(group)` with no interface lets the OS choose, and on a
   * machine with virtual adapters — Hyper-V, WSL, VirtualBox, a VPN — it
   * routinely chooses one of those instead of the real network. Nothing
   * errors; discovery just silently never finds anything, which is a miserable
   * thing to debug. Joining each interface explicitly avoids guessing.
   *
   * Loopback is included so two hosts on one machine can find each other,
   * which is exactly the case a developer tests with.
   *
   * @returns {boolean} whether at least one join succeeded
   */
  join(socket) {
    let joined = 0;
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family !== 'IPv4' && entry.family !== 4) continue;
        addresses.push(entry.address);
      }
    }

    for (const address of addresses) {
      try {
        socket.addMembership(this.group, address);
        joined++;
      } catch {
        // An interface that is down, or already joined. Others may still work.
      }
    }

    if (!joined) {
      // No interface accepted an explicit join; let the OS pick after all
      // rather than giving up on a configuration that might still work.
      try {
        socket.addMembership(this.group);
        joined++;
      } catch (err) {
        this.log(`could not join on the default interface either: ${err.message}`);
      }
    }

    try {
      socket.setMulticastTTL(1);
      // Without this, two instances on one machine cannot hear each other on
      // some platforms — and that is the setup this gets developed against.
      socket.setMulticastLoopback(true);
    } catch { /* not fatal; the join is what matters */ }

    return joined > 0;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
    }
    this.socket = null;
  }

  send(payload) {
    if (!this.socket) return;
    const body = Buffer.from(JSON.stringify({ magic: MAGIC, ...payload }));
    try {
      this.socket.send(body, 0, body.length, this.port, this.group);
    } catch (err) {
      this.log(`could not send: ${err.message}`);
    }
  }

  announce() {
    const config = this.getConfig() || {};
    this.send({
      type: 'announce',
      id: installId(config),
      name: config.hostName || os.hostname(),
      httpPort: config.port || 8420,
      httpsPort: config.httpsPort || 8443,
      platform: process.platform,
    });
  }

  receive(buffer, rinfo) {
    let message;
    try {
      message = JSON.parse(buffer.toString('utf8'));
    } catch {
      return; // Something else is using this group. Not our business.
    }
    if (!message || message.magic !== MAGIC) return;

    if (message.type === 'query') {
      // Answer, but not to ourselves — a query we sent comes straight back.
      if (this.announcing && message.id !== installId(this.getConfig() || {})) this.announce();
      return;
    }
    if (message.type !== 'announce' || !message.id) return;

    // Our own announcement, reflected back by the network stack.
    if (message.id === installId(this.getConfig() || {})) return;

    const host = {
      id: message.id,
      name: String(message.name || rinfo.address).slice(0, 60),
      address: rinfo.address,
      httpPort: Number(message.httpPort) || 8420,
      httpsPort: Number(message.httpsPort) || 8443,
      platform: typeof message.platform === 'string' ? message.platform.slice(0, 16) : null,
      seenAt: Date.now(),
    };

    const known = this.hosts.get(host.id);
    this.hosts.set(host.id, host);
    if (!known || known.address !== host.address) this.emit('found', host);
  }

  expire() {
    const cutoff = Date.now() - STALE_MS;
    for (const [id, host] of this.hosts) {
      if (host.seenAt < cutoff) {
        this.hosts.delete(id);
        this.emit('lost', host);
      }
    }
  }

  /** Hosts seen recently, newest first. */
  list() {
    const cutoff = Date.now() - STALE_MS;
    return [...this.hosts.values()]
      .filter((h) => h.seenAt >= cutoff)
      .sort((a, b) => b.seenAt - a.seenAt);
  }
}

module.exports = { Discovery, GROUP, PORT, ANNOUNCE_MS, STALE_MS, installId };
