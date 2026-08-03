/**
 * Media pipeline test: thumbnails, previews, and the codec fallbacks that
 * make iPhone footage play in browsers that cannot decode HEVC.
 *
 * Expects sample files under <library>/Samples. Generate them with:
 *   node test/make-samples.mjs
 *
 *   node test/media.mjs <password> [baseUrl]
 */

const PASSWORD = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:8420';

if (!PASSWORD) {
  console.error('Usage: node test/media.mjs <password> [baseUrl]');
  process.exit(2);
}

// Real user agents. The server distinguishes Safari from Chrome, and Chrome's
// UA also contains the word "Safari", which is the classic trap.
const UA_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let cookie = '';
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...options, headers, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

const q = encodeURIComponent;

let res = await req('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: PASSWORD }),
});
check('signed in', res.status === 200, `got ${res.status}`);

// --- listing classifies media ---------------------------------------------

res = await req('/api/list?path=/Samples');
const listing = await res.json();
const byName = Object.fromEntries((listing.files || []).map((f) => [f.name, f]));
check('sample folder lists 4 files', (listing.files || []).length === 4,
  `got ${(listing.files || []).length}`);
check('jpg classified as image', byName['photo-portrait.jpg']?.kind === 'image');
check('mp4 classified as video', byName['clip-h264.mp4']?.kind === 'video');
check('mov classified as video', byName['clip-hevc.mov']?.kind === 'video');

// --- thumbnails -----------------------------------------------------------

for (const name of ['photo-portrait.jpg', 'photo-landscape.png', 'clip-h264.mp4', 'clip-hevc.mov']) {
  res = await req(`/api/thumb?path=${q('/Samples/' + name)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const isWebp = bytes.subarray(0, 4).toString() === 'RIFF'
    && bytes.subarray(8, 12).toString() === 'WEBP';
  check(`thumbnail generated for ${name}`,
    res.status === 200 && bytes.length > 500 && isWebp,
    `status ${res.status}, ${bytes.length} bytes`);
}

res = await req(`/api/thumb?path=${q('/Samples/photo-landscape.png')}`);
check('thumbnails are cached immutably',
  (res.headers.get('cache-control') || '').includes('immutable'),
  res.headers.get('cache-control'));

const gridRes = await req(`/api/thumb?path=${q('/Samples/photo-landscape.png')}`);
const largeRes = await req(`/api/thumb&v=large`.replace('&', `?path=${q('/Samples/photo-landscape.png')}&`));
const gridLen = (await gridRes.arrayBuffer()).byteLength;
const largeLen = (await largeRes.arrayBuffer()).byteLength;
check('large variant is bigger than the grid tile', largeLen > gridLen,
  `grid ${gridLen}, large ${largeLen}`);

// --- metadata -------------------------------------------------------------

res = await req(`/api/meta?path=${q('/Samples/clip-h264.mp4')}`);
const meta = await res.json();
check('video duration is reported', Math.abs((meta.duration || 0) - 6) < 1.5,
  `duration ${meta.duration}`);
check('video dimensions are reported', meta.width === 1280 && meta.height === 720,
  `${meta.width}x${meta.height}`);

res = await req(`/api/meta?path=${q('/Samples/photo-portrait.jpg')}`);
const imgMeta = await res.json();
check('image dimensions are reported', imgMeta.width === 1600 && imgMeta.height === 2000,
  `${imgMeta.width}x${imgMeta.height}`);

// --- codec negotiation ----------------------------------------------------

res = await req(`/api/playback?path=${q('/Samples/clip-hevc.mov')}`,
  { headers: { 'user-agent': UA_CHROME } });
const hevcChrome = await res.json();
check('HEVC is detected', hevcChrome.codec === 'hevc', `codec ${hevcChrome.codec}`);
check('Chrome is sent to the transcoder for HEVC', hevcChrome.direct === false
  && hevcChrome.url.startsWith('/api/stream'), JSON.stringify(hevcChrome));

res = await req(`/api/playback?path=${q('/Samples/clip-hevc.mov')}`,
  { headers: { 'user-agent': UA_SAFARI } });
const hevcSafari = await res.json();
check('Safari gets the original HEVC untouched', hevcSafari.direct === true
  && hevcSafari.url.startsWith('/api/file'), JSON.stringify(hevcSafari));

res = await req(`/api/playback?path=${q('/Samples/clip-h264.mp4')}`,
  { headers: { 'user-agent': UA_CHROME } });
const h264Chrome = await res.json();
check('H.264 plays directly in Chrome', h264Chrome.direct === true
  && h264Chrome.codec === 'h264', JSON.stringify(h264Chrome));

// --- live transcode -------------------------------------------------------

res = await req(`/api/stream?path=${q('/Samples/clip-hevc.mov')}`);
check('transcode responds as mp4', res.status === 200
  && (res.headers.get('content-type') || '').includes('mp4'),
  `${res.status} ${res.headers.get('content-type')}`);

// Read just the head of the stream; the encode keeps running otherwise.
const reader = res.body.getReader();
const chunks = [];
let total = 0;
while (total < 64 * 1024) {
  const { value, done } = await reader.read();
  if (done) break;
  chunks.push(value);
  total += value.length;
}
await reader.cancel();
const head = Buffer.concat(chunks.map(Buffer.from));
check('transcoded output is a real MP4', head.subarray(4, 8).toString() === 'ftyp',
  head.subarray(0, 16).toString('hex'));
check('transcoded output arrives promptly', total > 0, `${total} bytes`);

// --- preview --------------------------------------------------------------

res = await req(`/api/preview?path=${q('/Samples/photo-landscape.png')}`,
  { headers: { 'user-agent': UA_CHROME } });
check('web-safe image previews as the original',
  res.status === 200 && (res.headers.get('content-type') || '').includes('png'),
  `${res.status} ${res.headers.get('content-type')}`);
await res.arrayBuffer();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
