// @ts-check
// lib/spaces/move-pull: the pull a TARGET home makes from a SOURCE home to carry a moved project's records and files between two homes (team/0.3/DESIGN-project-move.md, "A move to a Space on another
// server", with reviewer-3's six changes in team/0.3/reviews/remote-move-design.md). Pure protocol: it has no network, no key and no store of its own. A transport carries one JSON request at a time to
// the source and one answer back; the source's own pieces (its Space key, its gateway reads, the plan) are handed in. The moved project's DATA never passes through the mover's device.
//
//   hello  { move_id, to }                       source: a fresh nonce, signed with the SOURCE Space key. The target checks that signature against the source's published key BEFORE it signs anything (RM-2).
//   auth   { move_id, to, nonce, proof }         target: signs `vyre-move-pull-v1\n<from>\n<to>\n<move_id>\n<nonce>` with the TARGET Space key; the source checks it against the target's published key it
//                                                resolved when the mover asked for the evidence. The proof is bound to both Spaces, the move and this stream, and a nonce is single use. Answers { session }.
//   plan   { session }                           the source RECOMPUTES the plan under the mover's chain and requires its hash to equal the plan_hash the person approved (RM-1); answers the plan.
//   records{ session, ids }                      only ids in the recomputed plan, read under the mover's chain (so a field hidden from the mover is not sent), each with a checksum.
//   file   { session, path, offset, length }     only paths in the plan, in chunks of at most 512 KiB, each with a checksum.
//   sealed { session, ref }                      a sealed value as a blob sealed to the TARGET sealing process's key (RM-5): the courier, the relay and the target home see ciphertext only.
//   done   { session }                           ends the stream.
// Limits (RM-3 and the smaller notes): a pull may START within the window the evidence names and then lives until `done` or its cap (24 h) or 15 minutes with no request; per move, a cap on bytes
// served and on requests per minute; every request is checked against the plan before any read.
import crypto from "node:crypto";

export const PULL_SRC_TAG = "vyre-move-pull-src-v1";
export const PULL_TAG = "vyre-move-pull-v1";
export const SESSION_CAP_MS = 24 * 60 * 60 * 1000;
export const IDLE_MS = 15 * 60 * 1000;
export const NONCE_TTL_MS = 2 * 60 * 1000;
export const CHUNK_MAX = 512 * 1024; // base64 of this is under 1 MiB, the most one answer may carry over the home-to-home channel
export const DEFAULTS = Object.freeze({ maxBytes: 64 * 1024 ** 3, perMinute: 600, plan_ttl_ms: 2 * 60 * 1000 });

const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const sha = (/** @type {Buffer | string} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const MOVE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SPACE = /^spc_[a-z2-7]{12}$/;
/** The message the source signs first, then the one the target signs. @param {string} from @param {string} to @param {string} move @param {string} nonce */
export const srcMessage = (from, to, move, nonce) => `${PULL_SRC_TAG}\n${from}\n${to}\n${move}\n${nonce}`;
export const pullMessage = (from, to, move, nonce) => `${PULL_TAG}\n${from}\n${to}\n${move}\n${nonce}`;
/** The root of the per-file hashes the receipt carries: sha256 over the sorted `path\nsha256` lines. @param {{ path: string, sha256: string }[]} files */
export const filesRoot = (files) => sha(files.map(f => `${f.path}\n${f.sha256}`).sort().join("\n"));

/**
 * The SOURCE side of a pull.
 * @param {{
 *   space: string,
 *   grantOf: (move_id: string) => Promise<{ to: string, to_pub: string, person: string, plan_hash: string, project: string, expires: number } | null> | ({ to: string, to_pub: string, person: string, plan_hash: string, project: string, expires: number } | null),
 *   sign: (message: string) => Promise<string> | string,
 *   verify: (pub: string, message: string, sig: string) => Promise<boolean> | boolean,
 *   planFor: (g: { person: string, project: string, move_id: string, plan_hash: string, to: string }) => Promise<{ hash: string, ids: string[], files: { path: string, size: number, sha256: string }[], counts?: any }>,
 *   readRecord: (g: { person: string, move_id: string, plan_hash: string, project: string, to: string }, urn: string) => Promise<{ urn: string, version: number, data: any } | null>,
 *   readFile: (g: { person: string, move_id: string, plan_hash: string, project: string, to: string }, path: string, offset: number, length: number) => Promise<Buffer>,
 *   sealedFor?: (g: { person: string, move_id: string, plan_hash: string, project: string, to: string }, ref: string) => Promise<any>,
 *   now?: () => number, limits?: Partial<typeof DEFAULTS>, log?: (m: string) => void }} cfg
 */
export function createPullSource(cfg) {
  const now = cfg.now || Date.now;
  const lim = { ...DEFAULTS, ...(cfg.limits || {}) };
  /** @type {Map<string, { move: string, at: number }>} */ const nonces = new Map();
  /** @type {Map<string, any>} */ const sessions = new Map();
  const log = cfg.log || (() => {});
  const sweep = () => { const t = now(); for (const [k, v] of nonces) if (t - v.at > NONCE_TTL_MS) nonces.delete(k); for (const [k, s] of sessions) if (t - s.started > SESSION_CAP_MS || t - s.last > IDLE_MS) sessions.delete(k); };
  const grant = async (/** @type {any} */ i) => {
    if (!i || !MOVE.test(String(i.move_id)) || !SPACE.test(String(i.to))) throw err("bad_input", "name the move and the target space");
    const g = await cfg.grantOf(i.move_id);
    // the pull may START inside the window the evidence set; once begun it is the session's own cap that governs
    if (!g || g.to !== i.to) throw err("not_found", "no such move to pull");
    return g;
  };
  const live = (/** @type {any} */ i) => {
    sweep();
    const s = sessions.get(String(i && i.session));
    if (!s) throw err("denied", "that pull is not open");
    const t = now();
    s.last = t;
    s.window = s.window.filter((/** @type {number} */ x) => t - x < 60_000); s.window.push(t);
    if (s.window.length > lim.perMinute) throw err("rate_limited", "too many requests for this move; wait a moment");
    return s;
  };
  /** What the home's serving side is told about a session: who the move is for and exactly what was approved. @param {any} s */
  const gOf = (s) => ({ person: s.person, project: s.project, move_id: s.move, plan_hash: s.plan_hash, to: s.to });
  /** The plan, recomputed under the mover's chain now (cached for `plan_ttl_ms`), and held to the hash the person approved (RM-1). @param {any} s */
  const planOf = async (s) => {
    const t = now();
    if (s.plan && t - s.planAt < lim.plan_ttl_ms) return s.plan;
    /** @type {any} */ let p;
    try { p = await cfg.planFor(gOf(s)); } catch (e) { if (/** @type {any} */ (e).code === "stale_plan") { sessions.delete(s.id); throw err("plan_changed", "the project is no longer what was approved; nothing more is served"); } throw e; }
    if (!p || p.hash !== s.plan_hash) { sessions.delete(s.id); throw err("plan_changed", "the project is no longer what was approved; nothing more is served"); }
    s.plan = { ...p, idset: new Set(p.ids), fileMap: new Map(p.files.map((/** @type {any} */ f) => [f.path, f])) };
    s.planAt = t;
    return s.plan;
  };
  return Object.freeze({
    /** @param {{ move_id: string, to: string }} i */
    async hello(i) {
      sweep();
      const g = await grant(i);
      const nonce = crypto.randomBytes(18).toString("base64url");
      nonces.set(nonce, { move: i.move_id, at: now() });
      void g;
      return { nonce, src_sig: await cfg.sign(srcMessage(cfg.space, i.to, i.move_id, nonce)) };
    },
    /** @param {{ move_id: string, to: string, nonce: string, proof: string }} i */
    async auth(i) {
      sweep();
      const g = await grant(i);
      const n = nonces.get(String(i.nonce));
      nonces.delete(String(i.nonce)); // single use, spent whether the proof is good or not
      if (!n || n.move !== i.move_id) throw err("denied", "that proof is not for a challenge this home issued");
      let ok = false; try { ok = Boolean(await cfg.verify(g.to_pub, pullMessage(cfg.space, i.to, i.move_id, i.nonce), String(i.proof))); } catch { ok = false; }
      if (!ok) { log(`move pull: a proof for ${i.move_id} did not verify`); throw err("denied", "that proof does not show the target space"); }
      const id = `pt_${crypto.randomBytes(24).toString("base64url")}`;
      const t = now();
      sessions.set(id, { id, move: i.move_id, to: g.to, person: g.person, project: g.project, plan_hash: g.plan_hash, started: t, last: t, window: [], bytes: 0, plan: null, planAt: 0 });
      return { session: id };
    },
    /** @param {{ session: string }} i */
    async plan(i) {
      const s = live(i);
      s.plan = null;
      const p = await planOf(s);
      return { hash: p.hash, counts: p.counts ?? null, ids: p.ids, files: p.files };
    },
    /** @param {{ session: string, ids: string[] }} i */
    async records(i) {
      const s = live(i);
      const p = await planOf(s);
      if (!Array.isArray(i.ids) || i.ids.length < 1 || i.ids.length > 100) throw err("bad_input", "ask for 1 to 100 records");
      for (const u of i.ids) if (!p.idset.has(String(u))) throw err("denied", "that record is not part of the approved plan");
      const out = [];
      for (const u of i.ids) {
        const r = await cfg.readRecord(gOf(s), String(u));
        // a record the mover cannot read, or one that is gone, is simply absent: the target's count check then shows it
        if (r) out.push({ urn: r.urn, version: r.version, data: r.data, sha256: sha(JSON.stringify([r.urn, r.version, r.data])) });
      }
      s.bytes += JSON.stringify(out).length;
      if (s.bytes > lim.maxBytes) throw err("too_large", "this move has reached its size limit");
      return { records: out };
    },
    /** @param {{ session: string, path: string, offset: number, length: number }} i */
    async file(i) {
      const s = live(i);
      const p = await planOf(s);
      const f = p.fileMap.get(String(i.path));
      if (!f) throw err("denied", "that file is not part of the approved plan");
      const offset = Number(i.offset), length = Number(i.length);
      if (!Number.isInteger(offset) || offset < 0 || offset > f.size || !Number.isInteger(length) || length < 1 || length > CHUNK_MAX) throw err("bad_input", `ask for 1 to ${CHUNK_MAX} bytes inside the file`);
      const bytes = await cfg.readFile(gOf(s), f.path, offset, Math.min(length, f.size - offset));
      s.bytes += bytes.length;
      if (s.bytes > lim.maxBytes) throw err("too_large", "this move has reached its size limit");
      return { path: f.path, offset, size: f.size, sha256: f.sha256, base64: Buffer.from(bytes).toString("base64"), chunk_sha256: sha(Buffer.from(bytes)) };
    },
    /** @param {{ session: string, ref: string }} i */
    async sealed(i) {
      const s = live(i);
      await planOf(s);
      if (typeof cfg.sealedFor !== "function") throw err("unavailable", "this home cannot carry sealed values between homes yet");
      return cfg.sealedFor(gOf(s), String(i.ref));
    },
    /** @param {{ session: string }} i */
    async done(i) { const s = sessions.get(String(i && i.session)); if (s) sessions.delete(s.id); return { closed: true }; },
    /** Open sessions, for tests and the status line. */
    open: () => sessions.size,
  });
}

/**
 * The TARGET side: drives the source through `send`, one request at a time. It signs nothing until the source has proved itself (RM-2).
 * @param {{ from: string, to: string, move_id: string, send: (req: any) => Promise<any>,
 *   verifySource: (message: string, sig: string) => Promise<boolean> | boolean, sign: (message: string) => Promise<string> | string }} cfg
 */
export function createPuller(cfg) {
  /** @type {string | null} */ let session = null;
  const call = async (/** @type {string} */ t, /** @type {any} */ body) => { const r = await cfg.send({ t, ...body }); return r; };
  const need = () => { if (!session) throw err("denied", "connect first"); return session; };
  return Object.freeze({
    /** Hello, check the source's signature against ITS published key, only then sign, then open. */
    async connect() {
      const h = await call("hello", { move_id: cfg.move_id, to: cfg.to });
      if (!h || typeof h.nonce !== "string" || typeof h.src_sig !== "string") throw err("denied", "the source did not answer");
      let ok = false; try { ok = Boolean(await cfg.verifySource(srcMessage(cfg.from, cfg.to, cfg.move_id, h.nonce), h.src_sig)); } catch { ok = false; }
      if (!ok) throw err("denied", "the other end did not prove that it is the source space; nothing was signed");
      const a = await call("auth", { move_id: cfg.move_id, to: cfg.to, nonce: h.nonce, proof: await cfg.sign(pullMessage(cfg.from, cfg.to, cfg.move_id, h.nonce)) });
      if (!a || typeof a.session !== "string") throw err("denied", "the source refused the proof");
      session = a.session;
      return { connected: true };
    },
    plan: () => call("plan", { session: need() }),
    /** @param {string[]} ids */
    async records(ids) {
      const r = await call("records", { session: need(), ids });
      for (const x of (r && r.records) || []) if (x.sha256 !== sha(JSON.stringify([x.urn, x.version, x.data]))) throw err("corrupt", "a record's checksum does not match");
      return r.records || [];
    },
    /** One chunk of a file, checked against its checksum. @param {string} path @param {number} offset @param {number} length */
    async file(path, offset, length) {
      const r = await call("file", { session: need(), path, offset, length });
      const bytes = Buffer.from(String(r.base64 || ""), "base64");
      if (sha(bytes) !== r.chunk_sha256) throw err("corrupt", "a file chunk's checksum does not match");
      return { bytes, size: r.size, sha256: r.sha256, offset: r.offset };
    },
    sealed: (/** @type {string} */ ref) => call("sealed", { session: need(), ref }),
    async done() { if (session) { await call("done", { session }); session = null; } },
  });
}
