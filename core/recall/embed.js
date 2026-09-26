// @ts-check
// embed — text to vector, on this machine, so search can rank by meaning and not only by words.
//
// One model: all-MiniLM-L6-v2, 384 dimensions, int8 ONNX on the CPU through transformers.js.
// Nothing leaves the machine; the corpus is people's work.
//
// The library is NOT an npm dependency of vyre: with ONNX Runtime it is hundreds of MB, and it
// made `npm i -g vyre` a 750 MB install for a feature that works without it. Recall installs it
// on first use into <VYRE_HOME>/embedder (on a box, the home's volume), next to nothing else, and
// runs as full-text search until then. `vyre recall --setup` does the same thing now.
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

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, fork } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const DIM = 384;
export const MODEL = "Xenova/all-MiniLM-L6-v2";
/**
 * The library that runs it, at the exact version this code was measured and pruned against:
 * prune() knows its layout, and a newer one is a deliberate bump, not a surprise on first use.
 */
export const PACKAGE = "@huggingface/transformers";
export const RANGE = "4.3.0";
/** What a first use puts on disk, rounded, for the one line that says so: the library, then the model. */
export const DOWNLOAD_MB = { runtime: 105, model: 23 };

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

/** Are the weights already on disk? When not, the first load downloads them, and says so. */
export function cached(/** @type {string} */ cacheDir) {
  try { return fs.readdirSync(path.join(cacheDir, MODEL, "onnx")).some(f => f.endsWith(".onnx")); } catch { return false; }
}

/** Is the library installed in `dir`? */
export function installed(/** @type {string} */ dir) {
  return fs.existsSync(path.join(dir, "node_modules", ...PACKAGE.split("/"), "package.json"));
}

/** npm next to this node when there is one (npm i -g vyre put it there), else the one on PATH. */
function npmBin() {
  const near = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
  return fs.existsSync(near) ? near : "npm";
}

// What the CPU path never opens. ONNX Runtime ships its native library for every platform in
// one package, and on Linux its GPU providers (CUDA, TensorRT: 260 MB) beside it. onnxruntime-web
// is a dependency the node build imports only for its ort.node entry; its WebAssembly and browser
// bundles are 115 MB. Measured on 4.3.0 on Linux x64: 500 MB installed, 105 MB after this, and
// the model loads and embeds the same.
const GPU = /^libonnxruntime_providers_(cuda|tensorrt|rocm|migraphx|openvino|dml)\b/;
function prune(/** @type {string} */ dir) {
  const nm = path.join(dir, "node_modules");
  const bin = path.join(nm, "onnxruntime-node", "bin");
  const ls = (/** @type {string} */ d) => { try { return fs.readdirSync(d); } catch { return []; } };
  const rm = (/** @type {string} */ p) => fs.rmSync(p, { recursive: true, force: true });
  for (const napi of ls(bin)) {
    for (const plat of ls(path.join(bin, napi))) {
      const at = path.join(bin, napi, plat);
      if (plat !== process.platform) { rm(at); continue; }
      for (const arch of ls(at)) {
        if (arch !== process.arch) { rm(path.join(at, arch)); continue; }
        for (const f of ls(path.join(at, arch))) if (GPU.test(f)) rm(path.join(at, arch, f));
      }
    }
  }
  const web = path.join(nm, "onnxruntime-web", "dist");
  for (const f of ls(web)) if (!f.startsWith("ort.node.") || f.endsWith(".map")) rm(path.join(web, f));
}

/**
 * Install the library into `dir`. Resolves to {} or { why }, never throws. One install at a time
 * per dir: a second caller waits for the first. A half-finished install is removed, so the next
 * try starts clean rather than importing a broken tree.
 * @param {string} dir
 * @param {{ npm?: string, timeout?: number }} [opts]
 * @returns {Promise<{ why?: string }>}
 */
export function install(dir, { npm = npmBin(), timeout = 15 * 60_000 } = {}) {
  const key = path.resolve(dir);
  const running = installing.get(key);
  if (running) return running;
  const p = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: "vyre-embedder", private: true, description: "Recall's local search model runtime, installed by vyre on first use." }, null, 2) + "\n");
    const args = ["install", "--no-audit", "--no-fund", "--omit=dev", "--no-package-lock", "--loglevel=error", `${PACKAGE}@${RANGE}`];
    const err = await new Promise(resolve => {
      execFile(npm, args, { cwd: dir, timeout, maxBuffer: 4 << 20, env: { ...process.env, npm_config_update_notifier: "false" } },
        (e, _out, stderr) => resolve(e ? (String(stderr).trim().split("\n").pop() || e.message) : null));
    });
    if (err || !installed(dir)) {
      fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
      return { why: `the search engine did not download (${String(err || "npm installed nothing").slice(0, 160)})` };
    }
    try { prune(dir); } catch { /* a leftover platform binary costs disk, not correctness */ }
    return {};
  })().finally(() => installing.delete(key));
  installing.set(key, p);
  return p;
}
/** @type {Map<string, Promise<{ why?: string }>>} */
const installing = new Map();

/** The library from `dir`, else from wherever node would find it, else null. */
async function library(/** @type {string | undefined} */ dir) {
  if (dir && installed(dir)) {
    const file = createRequire(path.join(dir, "package.json")).resolve(PACKAGE);
    const m = await import(pathToFileURL(file).href);
    return m.pipeline ? m : m.default;
  }
  try { return await import(PACKAGE); } catch { return null; }
}

/**
 * Load the local model. Resolves to { embedder } or { why } and never throws, because "no
 * vectors" is an ordinary state for Recall to be in, not an error.
 *
 * Without the library in `runtime`, and with `download` true, it installs it there first. The
 * weights (about 23MB) are fetched once into `cacheDir` the same way; after that nothing touches
 * the network. Neither fetch carries anything about the user.
 * @param {{ cacheDir: string, runtime?: string, download?: boolean, npm?: string }} opts
 * @returns {Promise<{ embedder?: Embedder, why?: string }>}
 */
export async function load({ cacheDir, runtime, download = true, npm }) {
  let tf = await library(runtime).catch(() => null);
  if (!tf && runtime && download) {
    const r = await install(runtime, npm ? { npm } : {});
    if (r.why) return { why: `${r.why}; search is by keyword` };
    try { tf = await library(runtime); }
    catch (e) { return { why: `the search engine did not load (${String(/** @type {Error} */ (e).message).slice(0, 160)}); search is by keyword` }; }
  }
  if (!tf) return { why: "the search engine is not installed; search is by keyword" };
  try {
    tf.env.cacheDir = path.resolve(cacheDir);
    tf.env.allowRemoteModels = download;
    tf.env.allowLocalModels = true;
    tf.env.localModelPath = path.resolve(cacheDir);
    // One thread each way: a first index is hours of background work, and ONNX Runtime's
    // default of a thread per core held a Mac at about 500% CPU. Pacing is spawnEmbedder's.
    if (tf.env.backends && tf.env.backends.onnx) tf.env.backends.onnx.numThreads = 1;
    const pipe = await tf.pipeline("feature-extraction", MODEL, { dtype: "q8", device: "cpu",
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
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
    return { why: `the embedding model did not load (${String(/** @type {Error} */ (e).message).slice(0, 160)}); search is by keyword` };
  }
}

/**
 * The model in a process of its own at the lowest priority (embed-worker.js), so its CPU never
 * competes with the person's work or with vyred itself. Resolves like load(): { embedder } or
 * { why }. The embedder has close(), and usage() for measuring it. If the process dies, every
 * embed after that fails with why, and Recall says so.
 * @param {{ cacheDir: string, runtime?: string, download?: boolean, npm?: string }} opts
 * @returns {Promise<{ embedder?: Embedder & { close(): void, usage(): Promise<{ cpu: NodeJS.CpuUsage, nice: number | null }>, pid: number }, why?: string }>}
 */
export function spawnEmbedder(opts) {
  const child = fork(new URL("./embed-worker.js", import.meta.url), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
    execArgv: ["--disable-warning=ExperimentalWarning"],
  });
  try { if (child.pid) os.setPriority(child.pid, 19); } catch {}
  let err = "";
  child.stderr?.on("data", d => { err = (err + d).slice(-400); });
  let seq = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const waiting = new Map();
  let dead = /** @type {string | null} */ (null);
  const ask = (/** @type {any} */ m) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(dead));
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    child.send({ ...m, id });
  });
  /** @type {(r: any) => void} */
  let onLoaded = () => {};
  child.on("message", (/** @type {any} */ m) => {
    if (m.type === "loaded") return onLoaded(m);
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m);
  });
  child.on("exit", code => {
    dead = `the search model's process stopped (${code ?? "signal"})${err ? ": " + err.trim().split("\n").pop() : ""}`;
    for (const w of waiting.values()) w.reject(new Error(dead));
    waiting.clear();
    onLoaded({ model: null, why: dead });
  });
  return new Promise(resolve => {
    onLoaded = m => {
      onLoaded = () => {};
      if (!m.model) { child.kill(); return resolve({ why: m.why || "the embedding model did not load" }); }
      resolve({
        embedder: {
          model: m.model, pid: /** @type {number} */ (child.pid),
          async embed(text) { const r = await ask({ type: "embed", text: String(text ?? "") }); return new Float32Array(r.v); },
          async usage() { const r = await ask({ type: "usage" }); return { cpu: r.cpu, nice: r.nice }; },
          close() { if (!dead) { dead = "closed"; child.kill(); } },
        },
      });
    };
    child.send({ type: "load", opts });
  });
}
