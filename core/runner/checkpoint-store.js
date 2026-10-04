// @ts-check
// The space-side store for a session's checkpoints (DESIGN-local-runner section 4): the real thing behind the sync port that
// core/runner/sync.js calls (testing/fake-space.js has the same shape in memory). It lives at the HOME, on the home's own disk, in the
// Space's session folder; the storage pool replicates that folder as Working data (DESIGN-space-storage), nothing here changes then.
//
//   <root>/<session>/transcript.log        one JSON line { seq, line } per transcript line, seq 1..n with no gap
//   <root>/<session>/files/<hex path>/<v>  one file per version; <v>.del is a removal (a tombstone version)
//   <root>/<session>/cp/<turn>.json        one immutable record per checkpoint: { turn, seq, manifest, state }
//   <root>/<session>/CURRENT               { turn }: the commit point. A checkpoint is visible only once this names it.
//
// Rules:
//   - Whole or nothing. Every file is written to a temp name, fsynced, renamed, and its folder fsynced before the call returns. A
//     checkpoint is committed last, after the transcript reaches its seq and every file version in its manifest is on disk with the hash the
//     manifest names; until CURRENT is replaced (an atomic rename) getCheckpoint returns the previous one. A crash at any point leaves the
//     last complete checkpoint readable and nothing half-written visible (stray temp files are swept at the next write).
//   - Capped. At most `sessionBytes` per session in all (files, versions, transcript, records) and `fileBytes` per file: over the cap the
//     write is refused with code "quota" before anything is written. A full disk is "storage_full", also before anything is left behind.
//   - Authorized per call, as the session's chain: the chain must be this Space's and `authorize` must allow
//     sessions.checkpoint.write (put) or sessions.checkpoint.read (get) on vyre://<space>/session/<id>. Anything else is "not_found".
//   - A history cannot fork: lines already inside a committed checkpoint are never replaced; a second machine that resumed from checkpoint
//     N replaces the uncommitted lines after N, and a machine that still believes in an older turn is refused ("stale").

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ACTIONS = { write: "sessions.checkpoint.write", read: "sessions.checkpoint.read" };
export const CAPS = { sessionBytes: 2 * 1024 ** 3, fileBytes: 100 * 1024 ** 2, recordBytes: 64 * 1024 ** 2, rels: 100_000 };

const err = (code, message) => Object.assign(new Error(message), { code });
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const full = e => e && (e.code === "ENOSPC" || e.code === "EDQUOT");
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * @param {{ space: string, root: string, authorize: (i: { chain: any, action: string, resource: string }) => Promise<{ effect: string }>, caps?: Partial<typeof CAPS>, fs?: any }} o
 */
export function createCheckpointStore(o) {
  const fsx = o.fs || fs, caps = { ...CAPS, ...(o.caps || {}) };
  fs.mkdirSync(o.root, { recursive: true, mode: 0o700 });
  /** @type {Map<string, any>} per session: lines (the transcript), bytes (usage), hashes ("rel|v" -> sha), turn, seq (committed) */
  const sess = new Map();
  /** @type {Map<string, Promise<any>>} */
  const locks = new Map();
  const serial = (s, fn) => { const prev = locks.get(s) || Promise.resolve(); const next = prev.then(fn, fn); locks.set(s, next.catch(() => {})); return next; };

  const dirOf = s => path.join(o.root, s);
  const hexOf = rel => Buffer.from(rel).toString("hex");
  const syncDir = d => { try { const fd = fsx.openSync(d, "r"); try { fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); } } catch {} };
  /** Temp file, fsync, rename, folder fsync. A failure removes the temp file and leaves what was there. */
  function put(file, data) {
    const dir = path.dirname(file); fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`; let fd = -1;
    try {
      fd = fsx.openSync(tmp, "wx", 0o600); let n = 0; const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
      while (n < b.length) n += fsx.writeSync(fd, b, n, b.length - n);
      fsx.fsyncSync(fd); fsx.closeSync(fd); fd = -1;
      fsx.renameSync(tmp, file);
    } catch (e) { if (fd >= 0) try { fsx.closeSync(fd); } catch {} try { fsx.unlinkSync(tmp); } catch {} throw e; }
    syncDir(dir);
  }
  /** Run a write; a full disk becomes one plain refusal. */
  const guard = fn => { try { return fn(); } catch (e) { if (full(e)) throw err("storage_full", "the space's storage is full, so this checkpoint was not saved"); throw e; } };

  const ok = async (chain, action, session) => {
    if (!SESSION.test(String(session)) || !chain || chain.space !== o.space) throw err("not_found", "not found");
    const r = await o.authorize({ chain, action, resource: `vyre://${o.space}/session/${session}` });
    if (!r || r.effect !== "allow") throw err("not_found", "not found");
  };

  /** Open a session's state from disk (once per process): the complete transcript lines, usage, the committed turn. Sweeps stray temp files. */
  function load(s) {
    let st = sess.get(s); if (st) return st;
    const d = dirOf(s); st = { lines: [], bytes: 0, hashes: new Map(), turn: 0, seq: 0, prev: null };
    const walk = dir => { let n = 0; for (const e of fsx.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) n += walk(p); else if (/\.tmp-\d+-[0-9a-f]+$/.test(e.name)) fsx.rmSync(p, { force: true }); else n += fsx.statSync(p).size; } return n; };
    if (fsx.existsSync(d)) {
      st.bytes = walk(d);
      const t = path.join(d, "transcript.log");
      if (fsx.existsSync(t)) {
        const text = fsx.readFileSync(t, "utf8"); let good = 0, pos = 0;
        for (const l of text.split("\n")) { const end = pos + l.length + 1; pos = end; if (!l) continue; if (end > text.length) break; try { const e = JSON.parse(l); if (e.seq !== st.lines.length + 1) break; st.lines.push(e); good = end; } catch { break; } }
        if (good < text.length) { fsx.truncateSync(t, Buffer.byteLength(text.slice(0, good))); st.bytes -= text.length - good; }   // a torn tail from a crash
      }
      try { st.turn = JSON.parse(fsx.readFileSync(path.join(d, "CURRENT"), "utf8")).turn; const cp = JSON.parse(fsx.readFileSync(path.join(d, "cp", `${st.turn}.json`), "utf8")); st.seq = cp.seq; st.prev = cp.manifest; } catch { st.turn = 0; }
    }
    sess.set(s, st); return st;
  }
  const room = (st, n) => { if (st.bytes + n > caps.sessionBytes) throw err("quota", "this session has used all the storage the space gives it"); };
  const latest = dir => { let v = 0; try { for (const f of fsx.readdirSync(dir)) { const m = /^(\d+)(\.del)?$/.exec(f); if (m) v = Math.max(v, +m[1]); } } catch {} return v; };
  const blobPath = (s, rel, v, del) => path.join(dirOf(s), "files", hexOf(rel), String(v) + (del ? ".del" : ""));
  const hashOf = (st, s, rel, v) => {
    const k = rel + "|" + v; if (st.hashes.has(k)) return st.hashes.get(k);
    let h; if (fsx.existsSync(blobPath(s, rel, v, true))) h = "deleted"; else try { h = sha(fsx.readFileSync(blobPath(s, rel, v))); } catch { h = null; }
    if (h) st.hashes.set(k, h); return h;
  };

  const api = {
    async appendTranscript(chain, s, entries) {
      await ok(chain, ACTIONS.write, s);
      if (!Array.isArray(entries) || entries.length > 10_000) throw err("bad_input", "too many lines at once");
      return serial(s, () => guard(() => {
        const st = load(s), t = path.join(dirOf(s), "transcript.log"); fsx.mkdirSync(dirOf(s), { recursive: true, mode: 0o700 });
        const add = [];
        for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
          if (!Number.isInteger(e?.seq) || e.seq < 1 || typeof e.line !== "string") throw err("bad_input", "a transcript line needs a number and text");
          const n = st.lines.length + add.length;
          if (e.seq <= n) {
            const mine = e.seq <= st.lines.length ? st.lines[e.seq - 1] : add[e.seq - st.lines.length - 1];
            if (mine.line === e.line) continue;                       // the same line again: acknowledged, not stored twice
            if (e.seq <= st.seq) throw err("conflict", "that line is already part of a saved checkpoint");
            // A machine that resumed from the last checkpoint writes over what the dead one added after it.
            if (add.length) throw err("conflict", "lines out of order");
            const keep = st.lines.slice(0, e.seq - 1);
            const body = keep.map(x => JSON.stringify(x)).join("\n") + (keep.length ? "\n" : "");
            const was = fsx.statSync(t).size; put(t, body); st.bytes += Buffer.byteLength(body) - was; st.lines = keep;
            add.push({ seq: e.seq, line: e.line }); continue;
          }
          if (e.seq !== n + 1) throw err("gap", "a transcript line is missing before this one");
          add.push({ seq: e.seq, line: e.line });
        }
        const fresh = add.filter(e => e.seq > st.lines.length);
        if (fresh.length) {
          const text = fresh.map(e => JSON.stringify(e) + "\n").join(""), len = Buffer.byteLength(text);
          room(st, len);
          let size = 0; try { size = fsx.statSync(t).size; } catch {}
          let fd = -1;
          try { fd = fsx.openSync(t, "a", 0o600); fsx.writeSync(fd, text); fsx.fsyncSync(fd); fsx.closeSync(fd); fd = -1; }
          catch (e) { if (fd >= 0) try { fsx.closeSync(fd); } catch {} try { fsx.truncateSync(t, size); } catch {} throw e; }
          syncDir(dirOf(s));
          st.lines.push(...fresh); st.bytes += len;
        }
        return { acked: st.lines.length };
      }));
    },
    async getTranscript(chain, s, from = 1) {
      await ok(chain, ACTIONS.read, s);
      return serial(s, () => load(s).lines.filter(e => e.seq >= from));
    },
    async putFile(chain, s, rel, bytes) {
      await ok(chain, ACTIONS.write, s);
      if (typeof rel !== "string" || !rel || rel.length > 1024) throw err("bad_input", "a file needs a path");
      if (bytes !== null && !(bytes instanceof Uint8Array)) throw err("bad_input", "file bytes expected");
      if (bytes && bytes.length > caps.fileBytes) throw err("quota", "that file is larger than the space allows");
      return serial(s, () => guard(() => {
        const st = load(s), dir = path.join(dirOf(s), "files", hexOf(rel));
        const v = latest(dir) + 1, len = bytes ? bytes.length : 0;
        room(st, len + 1);
        if (bytes) { const b = Buffer.from(bytes); put(blobPath(s, rel, v), b); st.hashes.set(rel + "|" + v, sha(b)); }
        else { put(blobPath(s, rel, v, true), ""); st.hashes.set(rel + "|" + v, "deleted"); }
        st.bytes += len; return { version: v };
      }));
    },
    async getFile(chain, s, rel, version) {
      await ok(chain, ACTIONS.read, s);
      return serial(s, () => { try { return fsx.readFileSync(blobPath(s, String(rel), Number(version))); } catch { throw err("not_found", "no such version"); } });
    },
    async putCheckpoint(chain, s, cp) {
      await ok(chain, ACTIONS.write, s);
      if (!cp || !Number.isInteger(cp.turn) || cp.turn < 1 || !Number.isInteger(cp.seq) || cp.seq < 0 || typeof cp.manifest !== "object" || !cp.manifest) throw err("bad_input", "not a checkpoint");
      const text = JSON.stringify({ turn: cp.turn, seq: cp.seq, manifest: cp.manifest, state: cp.state });
      if (text.length > caps.recordBytes || Object.keys(cp.manifest).length > caps.rels) throw err("quota", "that checkpoint is larger than the space allows");
      return serial(s, () => guard(() => {
        const st = load(s);
        if (cp.turn <= st.turn) throw err("stale", "this session already has a newer checkpoint");
        if (cp.seq < st.seq || cp.seq > st.lines.length) throw err("incomplete", "the transcript does not reach this checkpoint");
        // Complete before visible: every file version the manifest names is on disk with the hash it names. Entries unchanged since the
        // last checkpoint were checked then.
        for (const [rel, m] of Object.entries(cp.manifest)) {
          const before = st.prev && st.prev[rel];
          if (before && before.version === m.version && before.hash === m.hash) continue;
          const h = hashOf(st, s, rel, m.version);
          if (!h || h !== m.hash) throw err("incomplete", `a file in this checkpoint is not saved (${rel.slice(0, 80)})`);
        }
        room(st, text.length + 16);
        const d = dirOf(s);
        put(path.join(d, "cp", `${cp.turn}.json`), text);
        put(path.join(d, "CURRENT"), JSON.stringify({ turn: cp.turn }));       // the commit
        st.bytes += text.length + 16; st.turn = cp.turn; st.seq = cp.seq; st.prev = cp.manifest;
        return { ok: true };
      }));
    },
    async getCheckpoint(chain, s) {
      await ok(chain, ACTIONS.read, s);
      return serial(s, () => { const st = load(s); if (!st.turn) return null; try { return JSON.parse(fsx.readFileSync(path.join(dirOf(s), "cp", `${st.turn}.json`), "utf8")); } catch { return null; } });
    },
    /** Bytes the session holds and the cap, for the settings card. */
    async usage(chain, s) { await ok(chain, ACTIONS.read, s); return serial(s, () => ({ bytes: load(s).bytes, cap: caps.sessionBytes, turn: load(s).turn })); },
  };

  return {
    ...api,
    /** The runner's sync port, bound to the chain the kernel mints for each call (`chainFn()`). */
    port(chainFn) {
      const c = () => chainFn();
      return {
        appendTranscript: (s, e) => api.appendTranscript(c(), s, e), getTranscript: (s, f) => api.getTranscript(c(), s, f),
        putFile: (s, rel, b) => api.putFile(c(), s, rel, b), getFile: (s, rel, v) => api.getFile(c(), s, rel, v),
        putCheckpoint: (s, cp) => api.putCheckpoint(c(), s, cp), getCheckpoint: s => api.getCheckpoint(c(), s),
      };
    },
  };
}
