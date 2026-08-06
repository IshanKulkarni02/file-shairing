/**
 * Finding other hosts on the network.
 *
 * Two Discovery instances are run in one process on a test-only multicast
 * group and port, so this exercises real UDP sockets rather than a stubbed
 * transport — the interesting failures here are all socket behaviour.
 *
 *   node test/discovery.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { Discovery, installId } = require(path.join(here, '..', 'lib', 'discovery.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const TEST_PORT = 8799;
const TEST_GROUP = '239.255.90.99';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves when `event` fires, or null after `ms`. */
function once(emitter, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    emitter.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

const started = [];
function makeHost(name, config = {}) {
  const cfg = { hostName: name, port: 8420, httpsPort: 8443, ...config };
  const d = new Discovery({
    getConfig: () => cfg,
    port: TEST_PORT,
    group: TEST_GROUP,
    log: () => {},
    ...config.deps,
  });
  started.push(d);
  return { discovery: d, config: cfg };
}

try {
  // --- one host finds another ----------------------------------------------

  const alice = makeHost('alice-laptop');
  const bob = makeHost('bob-desktop', { port: 9000, httpsPort: 9001 });

  alice.discovery.start();
  await wait(300);

  const foundPromise = once(alice.discovery, 'found', 4000);
  bob.discovery.start();
  const found = await foundPromise;

  check('a host that appears is discovered', found !== null, 'nothing was found');
  check('and is identified by name', found?.name === 'bob-desktop', found?.name);
  check('with the ports it actually serves on',
    found?.httpPort === 9000 && found?.httpsPort === 9001,
    `${found?.httpPort}/${found?.httpsPort}`);
  check('and an address to reach it at', Boolean(found?.address), found?.address);

  // --- a host does not discover itself --------------------------------------

  // Alice answered Bob's start-up query; give that reply a moment to land
  // before asking Bob what it knows.
  await wait(500);
  const seenByBob = bob.discovery.list();
  check('a host never lists itself',
    !seenByBob.some((h) => h.id === installId(bob.config)),
    JSON.stringify(seenByBob.map((h) => h.name)));
  check('but does list the other one',
    bob.discovery.list().some((h) => h.name === 'alice-laptop'),
    JSON.stringify(bob.discovery.list().map((h) => h.name)));

  // --- two machines with the same name stay distinct ------------------------

  {
    const twinA = makeHost('MacBook Pro');
    const twinB = makeHost('MacBook Pro');
    twinA.discovery.start();
    twinB.discovery.start();
    await wait(600);

    const idA = installId(twinA.config);
    const idB = installId(twinB.config);
    check('two installs get different ids even with the same name', idA !== idB);

    const seen = alice.discovery.list().filter((h) => h.name === 'MacBook Pro');
    check('and both show up rather than one hiding the other',
      seen.length === 2, `${seen.length} seen`);

    twinA.discovery.stop();
    twinB.discovery.stop();
  }

  // --- a new arrival does not have to wait for the next announcement ---------

  {
    // The query on start is what makes this quick; without it a newly opened
    // app would sit empty for up to a full announce interval.
    const late = makeHost('late-joiner');
    const quick = once(late.discovery, 'found', 2500);
    late.discovery.start();
    const heard = await quick;
    check('a host starting up hears about existing hosts promptly',
      heard !== null, 'it heard nothing within 2.5s');
    late.discovery.stop();
  }

  // --- what goes on the wire ------------------------------------------------

  {
    const record = alice.discovery.list()[0];
    const fields = Object.keys(record).sort().join(',');
    check('a discovered host carries only address-book fields',
      fields === 'address,httpPort,httpsPort,id,name,platform,seenAt', fields);

    // Nothing about the library, the accounts, or the certificate should ever
    // travel in a broadcast anyone on the network can read.
    const serialized = JSON.stringify(alice.discovery.list());
    check('and nothing about accounts, paths or keys',
      !/passw|secret|token|users|library|key|cert/i.test(serialized), serialized.slice(0, 120));
  }

  // --- hosts that go away expire -------------------------------------------

  {
    const leaving = makeHost('going-away');
    leaving.discovery.start();
    await wait(700);
    check('the leaving host was seen first',
      alice.discovery.list().some((h) => h.name === 'going-away'));

    leaving.discovery.stop();

    // Rather than wait out the real 32-second window, age the record directly
    // and run the sweep — the same code path, without the wall-clock wait.
    for (const host of alice.discovery.hosts.values()) {
      if (host.name === 'going-away') host.seenAt = Date.now() - 60_000;
    }
    const lost = once(alice.discovery, 'lost', 1000);
    alice.discovery.expire();
    const gone = await lost;

    check('a host that stops announcing is reported as gone', gone?.name === 'going-away', gone?.name);
    check('and drops off the list',
      !alice.discovery.list().some((h) => h.name === 'going-away'));
  }

  // --- junk on the group is ignored ----------------------------------------

  {
    const dgram = require('dgram');
    const noise = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const before = alice.discovery.list().length;

    await new Promise((resolve) => noise.bind(0, resolve));
    for (const payload of ['not json at all', JSON.stringify({ hello: 'world' }),
      JSON.stringify({ magic: 'something-else', type: 'announce', id: 'x' })]) {
      noise.send(Buffer.from(payload), TEST_PORT, TEST_GROUP);
    }
    await wait(400);
    noise.close();

    check('unrelated traffic on the group is ignored rather than crashing',
      alice.discovery.list().length === before,
      `${before} -> ${alice.discovery.list().length}`);
  }

  // --- stopping is clean and repeatable ------------------------------------

  {
    alice.discovery.stop();
    alice.discovery.stop();
    check('stopping twice is harmless', true);

    let threw = false;
    try { alice.discovery.send({ type: 'query' }); } catch { threw = true; }
    check('and sending after stopping does not throw', !threw);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  for (const d of started) {
    try { d.stop(); } catch { /* already stopped */ }
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
