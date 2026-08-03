'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let cached = null;

function candidates(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const list = [];
  // 0. Unpacked by lib/runtime.js when running as a packaged executable.
  if (process.env.LANSHARE_RUNTIME_DIR) {
    list.push(path.join(process.env.LANSHARE_RUNTIME_DIR, 'ffmpeg', exe));
    list.push(path.join(process.env.LANSHARE_RUNTIME_DIR, exe));
  }
  // 1. Shipped next to the executable.
  const baseDir = path.dirname(process.execPath);
  list.push(path.join(baseDir, exe));
  list.push(path.join(baseDir, 'bin', exe));
  list.push(path.join(baseDir, 'ffmpeg', 'bin', exe));
  // 2. Alongside the source tree, for `npm start`.
  list.push(path.join(__dirname, '..', 'bin', exe));
  return list;
}

function findOnPath(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(probe, [name], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = res.stdout.split(/\r?\n/).find((line) => line.trim());
      if (first && fs.existsSync(first.trim())) return first.trim();
    }
  } catch {
    /* fall through */
  }
  return null;
}

function locate(name) {
  for (const candidate of candidates(name)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return findOnPath(name);
}

/** Resolve ffmpeg/ffprobe once. Everything degrades gracefully when absent. */
function tools() {
  if (cached) return cached;
  cached = { ffmpeg: locate('ffmpeg'), ffprobe: locate('ffprobe') };
  cached.available = Boolean(cached.ffmpeg && cached.ffprobe);
  return cached;
}

/** Read duration, dimensions and rotation. Returns null when unreadable. */
function probe(file) {
  const { ffprobe } = tools();
  if (!ffprobe) return Promise.resolve(null);

  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_entries', 'format=duration:stream=width,height,codec_name,codec_type:stream_side_data=rotation',
      file,
    ];
    const proc = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const data = JSON.parse(out);
        const video = (data.streams || []).find((s) => s.codec_type === 'video') || {};
        const rotation = Number((video.side_data_list || []).find((s) => s.rotation)?.rotation || 0);
        const swap = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
        resolve({
          duration: Number(data.format?.duration) || 0,
          width: swap ? video.height : video.width,
          height: swap ? video.width : video.height,
          codec: video.codec_name || null,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/** Grab a single frame as a JPEG buffer, seeking to `atSeconds`. */
function grabFrame(file, atSeconds) {
  const { ffmpeg } = tools();
  if (!ffmpeg) return Promise.resolve(null);

  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      // -ss before -i is the fast seek: it jumps rather than decoding forward.
      '-ss', String(Math.max(0, atSeconds)),
      '-i', file,
      '-frames:v', '1',
      '-an',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3',
      'pipe:1',
    ];
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = [];
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.resume();
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      resolve(buf.length ? buf : null);
    });
    // A corrupt file can hang the decoder; do not wait forever.
    setTimeout(() => proc.kill('SIGKILL'), 20000).unref();
  });
}

/**
 * Live-transcode a video to browser-friendly H.264/AAC and pipe it out.
 * Used only when the client cannot play the original (HEVC .mov in Chrome).
 * Returns the child process so the caller can kill it if the client leaves.
 */
function transcodeStream(file, { startSeconds = 0, height = 720 } = {}) {
  const { ffmpeg } = tools();
  if (!ffmpeg) return null;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, startSeconds)),
    '-i', file,
    '-vf', `scale=-2:'min(${height},ih)'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    // fragmented MP4 so playback can start before the file is finished.
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
  return spawn(ffmpeg, args, { windowsHide: true });
}

module.exports = { tools, probe, grabFrame, transcodeStream };
