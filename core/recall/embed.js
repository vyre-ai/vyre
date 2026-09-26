// @ts-check
// embed — text to vector, on this machine, so search can rank by meaning and not only by words.
//
// One model: all-MiniLM-L6-v2, 384 dimensions, int8 ONNX on the CPU through transformers.js.
// Nothing leaves the machine; the corpus is people's work. The library is an optional
// dependency and is loaded only when first needed, so a machine without it runs Recall as
// full-text search and says so, rather than failing to start.
//
// Measured on an Apple M-series laptop over 256 real turns (median 400 characters):
//
//   one at a time        11.2 ms a turn
//   batches of 8         26.6 ms a turn
//   batches of 64       167.4 ms a turn
//
// Batching is SLOWER, because a batch is padded to its longest member and turn lengths have a
// long tail, and it changes the answer: the same text embeds a little differently depending on
// what shares its batch (up to 0.0085 per component). An index built one way and queried the
// other compares vectors from two numeric paths. So there is one path, one text at a time.
//
// The model reads 512 tokens and silently truncates past that: a 4,000 character turn embeds
// exactly like its first ~1,800 characters. Turns are therefore cut into chunks (chunks()), and
// each chunk gets its own vector.

import path from "node:path";

export const DIM = 384;
export const MODEL = "Xenova/all-MiniLM-L6-v2";

// Where to cut came from 600 real turns through the model's own tokeniser: 900 characters is
// 492 tokens at the densest 1% and 284 at the median, so all but base64 and minified JSON embed
// whole. 200 characters of overlap is more than a sentence, so a sentence across a cut survives
// intact in one of the two chunks. About 90% of turns are a single chunk.
export const CHUNK = 900;
export const OVERLAP = 200;

/**
 * One text as the pieces that each become a vector, in order. A cut lands on a space when there
 * is one within 120 characters, because a word split in half embeds as two meaningless tokens.
 * @param {string} text
 * @returns {{ off: number, text: string }[]}
 */
export function chunks(text, size = CHUNK, overlap = OVERLAP) {
  const s = String(text ?? "");
  if (!s.trim()) return [];
  if (s.length <= size) return [{ off: 0, text: s }];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + size);
    if (end < s.length) {
      const ws = s.lastIndexOf(" ", end);
      if (ws > i + size - 120) end = ws;
    }
    out.push({ off: i, text: s.slice(i, end) });
    if (end >= s.length) break;
    // Always move forward, whatever the overlap says, or a pathological input loops forever.
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

/** A vector as bytes: raw little-endian float32, 1,536 bytes for 384 dimensions. */
export function encode(/** @type {ArrayLike<number>} */ v) {
  const b = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i], i * 4);
  return b;
}

/** Bytes back to a vector. Throws on a length that cannot be one rather than returning junk. */
export function decode(/** @type {Uint8Array} */ buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length % 4) throw new Error(`not a vector: ${b.length} bytes is not a whole number of floats`);
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity. Vectors from the model are unit length, so this is a dot product. */
export function cosine(/** @type {ArrayLike<number>} */ a, /** @type {ArrayLike<number>} */ b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** @typedef {{ model: string, embed(text: string): Promise<Float32Array> }} Embedder */

/**
 * Load the local model. Resolves to { embedder } or { why } and never throws, because "no
 * vectors" is an ordinary state for Recall to be in, not an error.
 *
 * The weights (about 23MB) are fetched once into `cacheDir` unless `download` is false; after
 * that nothing touches the network. The fetch carries nothing about the user.
 * @param {{ cacheDir: string, download?: boolean }} opts
 * @returns {Promise<{ embedder?: Embedder, why?: string }>}
 */
export async function load({ cacheDir, download = true }) {
  let tf;
  try { tf = await import("@huggingface/transformers"); }
  catch { return { why: "the optional @huggingface/transformers package is not installed; search is full-text only" }; }
  try {
    tf.env.cacheDir = path.resolve(cacheDir);
    tf.env.allowRemoteModels = download;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = path.resolve(cacheDir);
    const pipe = await tf.pipeline("feature-extraction", MODEL, { dtype: "q8", device: "cpu" });
    return {
      embedder: {
        model: MODEL,
        async embed(text) {
          const out = await pipe(String(text ?? ""), { pooling: "mean", normalize: true });
          return new Float32Array(out.data);
        },
      },
    };
  } catch (e) {
    return { why: `the embedding model did not load (${String(/** @type {Error} */ (e).message).slice(0, 160)}); search is full-text only` };
  }
}
