/**
 * lib/central-index.js: key derivation, slot keys, and sealing/opening a
 * blob — all offline, no relay, no network. test/central-index-routes.mjs
 * is where this gets proven against a real relay and real servers.
 *
 *   node test/central-index.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ci = require(path.join(here, '..', 'lib', 'central-index.js'));
const { STORE_KEY_PATTERN } = require(path.join(here, '..', 'relay', 'server.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const PASSPHRASE = 'a shared passphrase every device types in';
const OTHER_PASSPHRASE = 'a completely different shared passphrase';

// --- key derivation ---------------------------------------------------------

const keysA1 = await ci.deriveKeys(PASSPHRASE);
const keysA2 = await ci.deriveKeys(PASSPHRASE);
const keysB = await ci.deriveKeys(OTHER_PASSPHRASE);

check('the same passphrase derives the same encryption key every time',
  keysA1.encryptionKey.equals(keysA2.encryptionKey));
check('the same passphrase derives the same lookup key every time',
  keysA1.lookupKey.equals(keysA2.lookupKey));
check('a different passphrase derives a different encryption key',
  !keysA1.encryptionKey.equals(keysB.encryptionKey));
check('a different passphrase derives a different lookup key',
  !keysA1.lookupKey.equals(keysB.lookupKey));
check('the encryption key and lookup key from the same passphrase are not the same key',
  !keysA1.encryptionKey.equals(keysA1.lookupKey));

let rejected = false;
try { await ci.deriveKeys('short'); } catch { rejected = true; }
check('a too-short passphrase is rejected', rejected);

// --- slot keys ---------------------------------------------------------------

const slotA1 = ci.deviceSlotKey(keysA1.lookupKey, 'device-one');
const slotA2 = ci.deviceSlotKey(keysA1.lookupKey, 'device-one');
const slotOther = ci.deviceSlotKey(keysA1.lookupKey, 'device-two');
const roster = ci.rosterSlotKey(keysA1.lookupKey);

check('a device slot key is deterministic for the same lookup key and device id', slotA1 === slotA2);
check('two different device ids get two different slot keys', slotA1 !== slotOther);
check('the roster slot key differs from any device slot key', roster !== slotA1 && roster !== slotOther);
check('a slot key from a different passphrase is different too',
  ci.deviceSlotKey(keysB.lookupKey, 'device-one') !== slotA1);
check('every slot key this module produces is valid as a relay storage key',
  STORE_KEY_PATTERN.test(slotA1) && STORE_KEY_PATTERN.test(roster));

// --- seal / open round trip ---------------------------------------------------

const deviceBlob = ci.buildDeviceBlob({
  deviceId: 'device-one',
  label: "Ishan's Desktop",
  entries: [
    { path: '/Drone/sunset.jpg', hash: 'abc123', size: 4200000, capturedAt: '2026-03-15T18:30:00' },
    { path: '/Motorcycle/coast.jpg', hash: 'def456', size: 3800000, capturedAt: '2026-06-02T14:00:00' },
  ],
});

const sealed = ci.seal(keysA1.encryptionKey, ci.deviceAad('device-one'), deviceBlob);
check('a sealed blob is a Buffer', Buffer.isBuffer(sealed));

const opened = ci.open(keysA1.encryptionKey, ci.deviceAad('device-one'), sealed);
check('opening with the right key and AAD returns exactly what was sealed',
  JSON.stringify(opened) === JSON.stringify(deviceBlob), JSON.stringify(opened));

rejected = false;
try { ci.open(keysB.encryptionKey, ci.deviceAad('device-one'), sealed); } catch { rejected = true; }
check('opening with the wrong passphrase\'s key fails rather than returning garbage', rejected);

rejected = false;
try { ci.open(keysA1.encryptionKey, ci.deviceAad('device-two'), sealed); } catch { rejected = true; }
check('a blob sealed for one device cannot be opened as if it belonged to another — a swapped-slot attack fails',
  rejected);

rejected = false;
try { ci.open(keysA1.encryptionKey, ci.ROSTER_AAD, sealed); } catch { rejected = true; }
check('a device blob cannot be opened as if it were the roster blob', rejected);

const tampered = Buffer.from(sealed);
tampered[tampered.length - 1] ^= 0xff;
rejected = false;
try { ci.open(keysA1.encryptionKey, ci.deviceAad('device-one'), tampered); } catch { rejected = true; }
check('a single flipped bit is caught, not silently decrypted into corrupt JSON', rejected);

rejected = false;
try { ci.open(keysA1.encryptionKey, ci.deviceAad('device-one'), Buffer.alloc(3)); } catch { rejected = true; }
check('a nonsense-short blob fails cleanly rather than throwing something unhandled', rejected);

// Compression is doing real work: a realistically repetitive index should
// come out smaller sealed than its own plaintext JSON, despite the
// encryption overhead (nonce + tag) added on top.
const bigBlob = ci.buildDeviceBlob({
  deviceId: 'device-one',
  label: 'Big Library',
  entries: Array.from({ length: 500 }, (_, i) => ({
    path: `/Photos/2026/img-${String(i).padStart(4, '0')}.jpg`,
    hash: 'a'.repeat(64),
    size: 4_000_000 + i,
    kind: 'image',
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    capturedAt: '2026-01-01T00:00:00',
  })),
});
const plainSize = Buffer.byteLength(JSON.stringify(bigBlob));
const sealedBig = ci.seal(keysA1.encryptionKey, ci.deviceAad('device-one'), bigBlob);
check('a realistic, repetitive index compresses well enough to beat its own plaintext size even after encryption',
  sealedBig.length < plainSize, `sealed ${sealedBig.length} vs plaintext ${plainSize}`);
check('a large blob still round-trips correctly',
  JSON.stringify(ci.open(keysA1.encryptionKey, ci.deviceAad('device-one'), sealedBig)) === JSON.stringify(bigBlob));

// --- roster merging ------------------------------------------------------------

let rosterState = ci.mergeRoster(null, 'device-one', 'Desktop');
check('the first publish ever creates a one-device roster',
  rosterState.devices.length === 1 && rosterState.devices[0].deviceId === 'device-one');

rosterState = ci.mergeRoster(rosterState, 'device-two', 'Laptop');
check('a second device\'s publish adds to the roster without disturbing the first',
  rosterState.devices.length === 2
  && rosterState.devices.some((d) => d.deviceId === 'device-one')
  && rosterState.devices.some((d) => d.deviceId === 'device-two'),
  JSON.stringify(rosterState));

const beforeRepublish = rosterState.devices.find((d) => d.deviceId === 'device-one').lastPublished;
await new Promise((r) => setTimeout(r, 5));
rosterState = ci.mergeRoster(rosterState, 'device-one', 'Desktop (renamed)');
check('re-publishing an existing device updates it in place rather than duplicating it',
  rosterState.devices.length === 2, JSON.stringify(rosterState));
const afterRepublish = rosterState.devices.find((d) => d.deviceId === 'device-one');
check('the re-published entry reflects the new label', afterRepublish.label === 'Desktop (renamed)');
check('and a fresher timestamp', afterRepublish.lastPublished !== beforeRepublish);
check('the other device is still untouched by device-one republishing',
  rosterState.devices.find((d) => d.deviceId === 'device-two').label === 'Laptop');

// --- device identity, persisted in config.json --------------------------------

{
  const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-central-index-'));
  try {
    process.env.LANSHARE_HOME = HOME;
    // A fresh require with the new LANSHARE_HOME already set — config.js
    // reads it once at load, same discipline test/index-db.mjs relies on.
    delete require.cache[require.resolve(path.join(here, '..', 'lib', 'config.js'))];
    const configLib = require(path.join(here, '..', 'lib', 'config.js'));
    const { config } = configLib.loadOrCreate();

    check('a fresh config has no device id yet', !config.deviceId);
    const id1 = ci.ensureDeviceId(config, configLib);
    check('one is generated on first need', typeof id1 === 'string' && id1.length > 0);
    const id2 = ci.ensureDeviceId(config, configLib);
    check('and the same object keeps returning the same id', id1 === id2);

    const reloaded = configLib.load();
    check('the generated id was actually persisted to disk, not just held in memory', reloaded.deviceId === id1);

    check('the label defaults to something non-empty when nothing is configured',
      typeof ci.deviceLabel(config) === 'string' && ci.deviceLabel(config).length > 0);
    config.centralIndex = { label: 'My Custom Label' };
    check('an explicit label overrides the default', ci.deviceLabel(config) === 'My Custom Label');
  } finally {
    delete process.env.LANSHARE_HOME;
    rmSync(HOME, { recursive: true, force: true });
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
