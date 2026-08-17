'use strict';

/**
 * Local, offline image/text embeddings for "photos of whiteboards" — the
 * class of search a filename or EXIF field can never answer (Phase N).
 *
 * CLIP is a dual-tower model: an image encoder and a text encoder trained to
 * land related images and captions near each other in the same vector space.
 * That is the whole trick this module exists to use — embed every photo once
 * in the background (lib/content-index.js), embed a typed query at search
 * time, and rank by cosine similarity. Both towers are used through
 * @huggingface/transformers (formerly Xenova/transformers.js), which runs
 * the actual ONNX graph in-process via onnxruntime-node — no Python, no
 * separate server to keep running, no account. That is a deliberate fit with
 * this project's own precedent: lib/index-db.js chose Node's built-in
 * `node:sqlite` over better-sqlite3 for the same reason `sharp` is the one
 * native module this app already carries rather than shelling out to a
 * separate image tool. This is the second.
 *
 * Unlike lib/nl-rules.js's local model (a real Ollama server this app never
 * runs itself), CLIP needs no external process at all — just model weights,
 * fetched once from Hugging Face on first use and cached on disk thereafter
 * (see cacheDir() below). That first fetch needs internet and is genuinely
 * large — see MODEL_ID's own comment — which is exactly why this whole
 * feature is opt-in (config.contentSearch.enabled) rather than something
 * that surprises a person on first launch.
 */

const fs = require('fs');
const path = require('path');
const configLib = require('./config');

// clip-vit-base-patch32's vision and text towers, at the library's default
// export/dtype. fp16 was tried first to halve the download and failed hard —
// onnxruntime-node's CPU execution provider throws during graph
// initialization on this model's text tower under fp16 (a layer-norm fusion
// pass reaching for a constant that quantization had already folded away).
// Not a config tweak worth chasing further: the default export is proven to
// load and run correctly, and this is a locally-run background feature, not
// a bandwidth-metered one. Pinned to one model id rather than left
// configurable: a stored embedding is only ever comparable to another
// embedding from the exact same model, and giving every device on the
// network its own idea of which model to run would silently break that the
// moment two devices' indexes were ever compared.
const MODEL_ID = 'Xenova/clip-vit-base-patch32';
const EMBEDDING_DIMS = 512;

class ClipError extends Error {}

let transformersMod = null;
/** Required lazily — a ~9 MB package, harmless to load, but every caller
 * that never touches content search (which is most of this app, most of the
 * time) has no reason to pay for it. */
function transformers() {
  if (!transformersMod) {
    // eslint-disable-next-line global-require
    transformersMod = require('@huggingface/transformers');
  }
  return transformersMod;
}

/**
 * Model weights are large (a few hundred MB) and are machine-wide, not
 * per-library data — two libraries on one machine share one download. They
 * live beside the other server-level state (lib/config.js's
 * `.lanshare-server`, which already holds sessions and accounts) rather than
 * inside node_modules, which is exactly where @huggingface/transformers
 * would otherwise put them by default: that path sits inside a packaged
 * app's read-only, asar-packed install directory, and would vanish on every
 * upgrade.
 */
function cacheDir() {
  return path.join(configLib.serverStateDir(), 'model-cache');
}

let loadPromise = null;
/**
 * Loads both towers exactly once per process, however many callers ask for
 * them concurrently — a second overlapping call awaits the same in-flight
 * load rather than starting a second one.
 */
function ensureModel() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const {
        AutoTokenizer, AutoProcessor, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, env,
      } = transformers();
      env.cacheDir = cacheDir();

      try {
        const [tokenizer, processor, textModel, visionModel] = await Promise.all([
          AutoTokenizer.from_pretrained(MODEL_ID),
          AutoProcessor.from_pretrained(MODEL_ID),
          CLIPTextModelWithProjection.from_pretrained(MODEL_ID),
          CLIPVisionModelWithProjection.from_pretrained(MODEL_ID),
        ]);
        return {
          tokenizer, processor, textModel, visionModel,
        };
      } catch (err) {
        throw new ClipError(`Could not load the local content-search model (${err.message}). `
          + 'It downloads from Hugging Face on first use, so this usually means no internet '
          + 'connection was available the first time content search ran.');
      }
    })().catch((err) => {
      // A failed load must not wedge every future attempt behind the same
      // rejected promise — a later call (once the network is back) gets a
      // fresh try, exactly the retry-is-cheap reasoning lib/geocode.js
      // already applies to its own failed lookups.
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

function normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Whether the model is already downloaded, without triggering a download to find out. */
function isCached() {
  const dir = path.join(cacheDir(), MODEL_ID.replace('/', path.sep));
  return fs.existsSync(dir);
}

/** Embed one image file (a path is enough — RawImage.read decodes it internally, via sharp in Node). */
async function embedImageFile(absPath) {
  const { RawImage } = transformers();
  const { processor, visionModel } = await ensureModel();
  const image = await RawImage.read(absPath);
  const inputs = await processor(image);
  const { image_embeds: imageEmbeds } = await visionModel(inputs);
  return normalize(Float32Array.from(imageEmbeds.data));
}

/** Embed a typed search query into the same space an image landed in. */
async function embedText(text) {
  const { tokenizer, textModel } = await ensureModel();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const { text_embeds: textEmbeds } = await textModel(inputs);
  return normalize(Float32Array.from(textEmbeds.data));
}

module.exports = {
  ClipError, MODEL_ID, EMBEDDING_DIMS, cacheDir, isCached, ensureModel, embedImageFile, embedText,
};
