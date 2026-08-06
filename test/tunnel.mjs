/**
 * Reaching a host over the internet, through a relay.
 *
 * Runs a real relay, a real LANShare server and a real client, all talking
 * over real sockets. The properties worth proving — that the relay cannot
 * read what it carries, that a tampered frame is refused, that a replayed one
 * is refused — are all invisible to a mocked transport.
 *
 *   node test/tunnel.mjs
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const HOME = mkdtempSync(path.join(tmpdir(), 'lanshare-tunnel-'));
process.env.LANSHARE_HOME = HOME;

const configLib = require(path.join(here, '..', 'lib', 'config.js'));
const serverApp = require(path.join(here, '..', 'lib', 'server-app.js'));
const tunnel = require(path.join(here, '..', 'lib', 'tunnel.js'));
const frames = require(path.join(here, '..', 'lib', 'frames.js'));
const { createRelay } = require(path.join(here, '..', 'relay', 'server.js'));

const PASSWORD = 'a properly long tunnel password';
const LOCAL_PORT = 8571;
const RELAY_PORT = 8572;
const TAP_PORT = 8573;

const SECRET_TEXT = 'PLAINTEXT-MARKER-THAT-MUST-NOT-CROSS-THE-RELAY';

let relay = null;
let tap = null;
let handle = null;
let host = null;
let client = null;

try {
  // --- pairing codes --------------------------------------------------------

  {
    const pairing = tunnel.createPairing();
    check('a pairing code is produced', /^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/.test(pairing.code), pairing.code);

    const parsed = tunnel.parsePairing(pairing.code);
    check('and reads back to the same secret', parsed.secret.equals(pairing.secret));
    check('and the same room', parsed.room === pairing.room);

    // Typed by a person, from a screen, possibly badly.
    check('lower case is accepted', tunnel.parsePairing(pairing.code.toLowerCase()).room === pairing.room);
    check('spaces instead of dashes are accepted',
      tunnel.parsePairing(pairing.code.replace(/-/g, ' ')).room === pairing.room);
    check('O typed for zero is accepted',
      tunnel.parsePairing(pairing.code.replace(/0/g, 'O')).room === pairing.room);

    let rejected = false;
    try { tunnel.parsePairing('ABC'); } catch { rejected = true; }
    check('a code of the wrong length is refused', rejected);

    // The relay sees room names. If the room were the secret, running a relay
    // would hand you the key to every library using it.
    check('the room name is not the secret',
      !pairing.room.includes(tunnel.toBase32(pairing.secret).slice(0, 12)), pairing.room);
  }

  // --- a real end-to-end connection ----------------------------------------

  const { config } = configLib.loadOrCreate();
  config.port = LOCAL_PORT;
  config.httpsPort = 0;
  configLib.save(config);
  configLib.setUser('admin', PASSWORD);

  mkdirSync(path.join(HOME, 'library', 'Private'), { recursive: true });
  writeFileSync(path.join(HOME, 'library', 'Private', 'secret.txt'), SECRET_TEXT);

  handle = await serverApp.start(configLib.load());
  relay = createRelay({ log: () => {} });
  await relay.listen(RELAY_PORT, '127.0.0.1');
  check('the relay is listening', true);

  const pairing = tunnel.createPairing();

  host = new tunnel.TunnelHost({
    relayHost: '127.0.0.1',
    relayPort: RELAY_PORT,
    pairing,
    localPort: LOCAL_PORT,
    log: () => {},
  });
  host.start();

  // Everything the relay carries, captured by sitting a recording proxy in
  // front of it. Hooking every socket in the process would also catch the
  // host's own plaintext HTTP call to its local server, which never goes near
  // the relay — and would make this test claim a leak that does not exist.
  const carried = [];
  tap = net.createServer((fromClient) => {
    const toRelay = net.createConnection({ host: '127.0.0.1', port: RELAY_PORT });
    fromClient.on('data', (chunk) => { carried.push(Buffer.from(chunk)); toRelay.write(chunk); });
    toRelay.on('data', (chunk) => { carried.push(Buffer.from(chunk)); fromClient.write(chunk); });
    const bye = () => { fromClient.destroy(); toRelay.destroy(); };
    fromClient.on('close', bye);
    toRelay.on('close', bye);
    fromClient.on('error', bye);
    toRelay.on('error', bye);
  });
  await new Promise((resolve) => tap.listen(TAP_PORT, '127.0.0.1', resolve));

  client = new tunnel.TunnelClient({
    relayHost: '127.0.0.1',
    relayPort: TAP_PORT,
    pairing: tunnel.parsePairing(pairing.code),
  });
  await client.connect();
  check('the two ends meet through the relay', Boolean(client.channel));

  {
    const login = await client.call('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    check('signing in works over the tunnel', login.status === 200, `got ${login.status}`);

    // Everything through the tunnel reaches the local server over loopback,
    // so without a marker a visitor from the internet would be recorded as
    // sitting at the keyboard — on the Devices screen, and in the login
    // throttle, where a remote guesser could then lock the owner out.
    const sessions = require(path.join(here, '..', 'lib', 'sessions.js'));
    check('a session opened over the internet is not recorded as local',
      sessions.list('admin').some((s) => /internet/i.test(s.ip)),
      JSON.stringify(sessions.list('admin').map((s) => s.ip)));

    const listing = await client.call('/api/list?path=%2FPrivate');
    check('the library can be listed over the tunnel', listing.status === 200);
    check('and shows the file',
      JSON.parse(listing.body.toString()).files?.[0]?.name === 'secret.txt');

    const download = await client.call('/api/file?path=%2FPrivate%2Fsecret.txt');
    check('a file downloads over the tunnel',
      download.body.toString() === SECRET_TEXT, download.body.toString().slice(0, 40));

    // --- the property the whole design exists for --------------------------

    const everything = Buffer.concat(carried);
    check('the relay carried a meaningful amount of traffic', everything.length > 200, String(everything.length));
    check('but the file contents never crossed it in the clear',
      !everything.includes(SECRET_TEXT), 'the plaintext was visible to the relay');
    check('nor did the password',
      !everything.includes(PASSWORD), 'the password was visible to the relay');
    check('nor even the path being requested',
      !everything.includes('/api/file'), 'request paths were visible to the relay');
  }

  // --- larger payloads survive the framing ---------------------------------

  {
    // TCP gives no message boundaries; anything that assumes one chunk is one
    // message works on localhost and corrupts over a real network.
    const big = Buffer.alloc(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 61) % 256;
    writeFileSync(path.join(HOME, 'library', 'Private', 'big.bin'), big);

    const res = await client.call('/api/file?path=%2FPrivate%2Fbig.bin');
    check('a payload spanning many TCP segments arrives whole',
      res.body.equals(big), `${res.body.length} of ${big.length} bytes`);
  }

  {
    // A phone video is an ordinary thing to have in a photo library, and one
    // does not fit in a single frame. Testing only with small files hid this
    // completely — both directions failed outright at 25 MB.
    const video = Buffer.alloc(9 * 1024 * 1024);
    for (let i = 0; i < video.length; i += 4096) video[i] = (i / 4096) % 256;
    writeFileSync(path.join(HOME, 'library', 'Private', 'clip.mp4'), video);

    const down = await client.call('/api/file?path=%2FPrivate%2Fclip.mp4');
    check('a file larger than one frame downloads over the tunnel',
      down.body.equals(video), `${down.body.length} of ${video.length} bytes`);

    const boundary = '----lanshare-test-boundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sent.mp4"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n',
    );
    const body = Buffer.concat([head, video, Buffer.from(`\r\n--${boundary}--\r\n`)]);

    const up = await client.call('/api/upload?dir=%2FPrivate&rel=sent.mp4', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    check('and one that size uploads too', up.status === 200, up.body.toString().slice(0, 80));

    const back = await client.call('/api/file?path=%2FPrivate%2Fsent.mp4');
    check('arriving byte for byte at the other end', back.body.equals(video),
      `${back.body.length} of ${video.length} bytes`);
  }

  // --- frames cannot be tampered with or replayed --------------------------

  {
    const keys = frames.deriveKeys(pairing.secret);
    const sealed = frames.seal(keys.hostToClient, 0, Buffer.from('hello'));

    const opened = frames.open(keys.hostToClient, sealed, 0);
    check('a sealed frame opens with the right key', opened.plaintext.toString() === 'hello');

    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    let caught = null;
    try { frames.open(keys.hostToClient, tampered, 0); } catch (err) { caught = err; }
    check('a single flipped bit is detected', caught !== null);
    check('and says the frame was altered rather than something cryptic',
      /altered in transit/i.test(caught?.message || ''), caught?.message);

    caught = null;
    try { frames.open(keys.hostToClient, sealed, 1); } catch (err) { caught = err; }
    check('a replayed frame is refused because its counter is stale', caught !== null);

    // Separate keys per direction: a frame the host sent must not be
    // replayable back at it as though the client had sent it.
    caught = null;
    try { frames.open(keys.clientToHost, sealed, 0); } catch (err) { caught = err; }
    check('a frame cannot be replayed back in the other direction', caught !== null);

    caught = null;
    try { frames.open(frames.deriveKeys(Buffer.from('a different secret')).hostToClient, sealed, 0); }
    catch (err) { caught = err; }
    check('and the wrong pairing code cannot open it at all', caught !== null);
  }

  // --- the framing itself ---------------------------------------------------

  {
    const reader = new frames.FrameReader();
    const one = frames.encodeFrame(Buffer.from('first'));
    const two = frames.encodeFrame(Buffer.from('second'));

    check('two frames in one chunk both come out',
      reader.push(Buffer.concat([one, two])).map((f) => f.toString()).join(',') === 'first,second');

    // The case that breaks naive implementations: a frame split across reads.
    const split = frames.encodeFrame(Buffer.from('divided'));
    check('a frame split mid-header yields nothing yet', reader.push(split.subarray(0, 2)).length === 0);
    check('and still nothing mid-body', reader.push(split.subarray(2, 6)).length === 0);
    check('but comes out whole once the rest arrives',
      reader.push(split.subarray(6)).map((f) => f.toString()).join('') === 'divided');

    let refused = false;
    try {
      const absurd = Buffer.alloc(4);
      absurd.writeUInt32BE(frames.MAX_FRAME_BYTES + 1, 0);
      new frames.FrameReader().push(absurd);
    } catch { refused = true; }
    check('an absurd length is refused before anything is allocated for it', refused);
  }

  // --- the relay refuses nonsense ------------------------------------------

  {
    const badHello = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: RELAY_PORT }, () => {
        socket.write(frames.encodeFrame(JSON.stringify({ role: 'wizard', room: 'x' })));
      });
      // Read the refusal, or the stream stays paused and never notices the
      // relay hanging up.
      socket.resume();
      socket.on('close', () => resolve('closed'));
      socket.on('error', () => resolve('closed'));
      setTimeout(() => { socket.destroy(); resolve('still open'); }, 2000);
    });
    check('the relay hangs up on an unknown role', badHello === 'closed', badHello);
  }

  {
    // A second host claiming the same room must not be able to evict the
    // real one — that would be a way to hijack a pairing.
    const taken = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: RELAY_PORT }, () => {
        socket.write(frames.encodeFrame(JSON.stringify({ role: 'host', room: pairing.room })));
      });
      socket.resume();
      socket.on('close', () => resolve('closed'));
      setTimeout(() => { socket.destroy(); resolve('still open'); }, 2000);
    });
    check('a second host cannot take over an occupied room', taken === 'closed', taken);

    const stillWorks = await client.call('/api/me');
    check('and the original connection is unaffected', stillWorks.status === 200, `got ${stillWorks.status}`);
  }

  // --- losing the relay -----------------------------------------------------

  {
    const closed = new Promise((resolve) => client.once('close', resolve));
    await relay.close();
    relay = null;
    await closed;

    let error = null;
    try { await client.call('/api/me'); } catch (err) { error = err; }
    check('a request after the relay goes away fails clearly rather than hanging',
      error !== null && /closed|not connected/i.test(error.message), error?.message);
  }
} catch (err) {
  fail++;
  console.log(`  FAIL  unexpected error -> ${err.stack || err.message}`);
} finally {
  client?.close();
  host?.stop();
  if (tap) await new Promise((r) => tap.close(r));
  if (relay) await relay.close().catch(() => {});
  if (handle) await handle.stop().catch(() => {});
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
