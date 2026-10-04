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
//     checkpoint.write (put) or checkpoint.read (get) on vyre://<space>/checkpoint/<id> (its own resource type, not `session`: sessions are owner-scoped for reads). Anything else is "not_found".
//   - A history cannot fork: lines already inside a committed checkpoint are never replaced; a second machine that resumed from checkpoint
//     N replaces the uncommitted lines after N, and a machine that still believes in an older turn is refused ("stale").

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ACTIONS = { write: "checkpoint.write", read: "checkpoint.read" };
export const CAPS = { sessionBytes: 2 * 1024 ** 3, fileBytes: 100 * 1024 ** 2, recordBytes: 64 * 1024 ** 2, rels: 100_000 };

const err = (code, message) => Object.assign(new Error(message), { code });
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const full = e => e && (e.code === "ENOSPC" || e.code === "EDQUOT");
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;
const STRIDE = 256, CHUNK = 1 << 20;

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
    // Only a session's own chain: an assistant acting for the person (an agent hop entered from a surface, with no session of its own) never reaches a session's history.
    for (const h of chain.hops || []) if (h.actor && h.actor.kind === "agent" && !(h.via && typeof h.via.session === "string" && h.via.session)) throw err("not_found", "not found");
    const r = await o.authorize({ chain, action, resource: `vyre://${o.space}/checkpoint/${session}` });
    if (!r || r.effect !== "allow") throw err("not_found", "not found");
  };

  /** Streams a transcript file's complete lines from a byte offset, 1 MB at a time: cb(entry, startOffset, endOffset); a false answer, a torn line or a bad line ends the scan. Returns where the last good line ended and the file's size. */
  function scanFile(file, from, cb) {
    let fd; try { fd = fsx.openSync(file, "r"); } catch { return { end: from, size: 0 }; }
    try {
      const size = fsx.fstatSync(fd).size, buf = Buffer.allocUnsafe(CHUNK);
      let pos = from, carry = Buffer.alloc(0), carryStart = from, good = from;
      while (pos < size) {
        const n = fsx.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos); if (!n) break;
        pos += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        let off = 0, i;
        while ((i = data.indexOf(10, off)) >= 0) {
          if (i > off) { let e; try { e = JSON.parse(data.subarray(off, i).toString("utf8")); } catch { return { end: good, size }; } if (cb(e, carryStart + off, carryStart + i + 1) === false) return { end: good, size }; }
          good = carryStart + i + 1; off = i + 1;
        }
        carry = Buffer.from(data.subarray(off)); carryStart += off;
      }
      return { end: good, size };
    } finally { fsx.closeSync(fd); }
  }
  /** The lines numbered from..to (inclusive), read from disk from the nearest indexed offset. */
  function readLines(st, s, from, to = Infinity) {
    if (from > st.count) return [];
    const out = [];
    scanFile(path.join(dirOf(s), "transcript.log"), st.idx[Math.floor((from - 1) / STRIDE)] || 0, e => { if (e.seq > to) return false; if (e.seq >= from) out.push(e); });
    return out;
  }
  /** The byte offset where line `seq` starts. */
  function offsetOf(st, s, seq) {
    let at = null;
    scanFile(path.join(dirOf(s), "transcript.log"), st.idx[Math.floor((seq - 1) / STRIDE)] || 0, (e, start) => { if (e.seq === seq) { at = start; return false; } });
    return at;
  }

  /** Open a session's state from disk (once per process): the transcript's line count, a sparse offset index (one entry per STRIDE lines) and its last line, usage, the committed turn. Sweeps stray temp files. */
  function load(s) {
    let st = sess.get(s); if (st) return st;
    const d = dirOf(s); st = { count: 0, idx: [], last: null, tsize: 0, bytes: 0, hashes: new Map(), turn: 0, seq: 0, prev: null };
    const walk = dir => { let n = 0; for (const e of fsx.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) n += walk(p); else if (/\.tmp-\d+-[0-9a-f]+$/.test(e.name)) fsx.rmSync(p, { force: true }); else n += fsx.statSync(p).size; } return n; };
    if (fsx.existsSync(d)) {
      st.bytes = walk(d);
      const t = path.join(d, "transcript.log");
      if (fsx.existsSync(t)) {
        const r = scanFile(t, 0, (e, start) => { if (e.seq !== st.count + 1) return false; if (st.count % STRIDE === 0) st.idx.push(start); st.count++; st.last = e; });
        if (r.end < r.size) { fsx.truncateSync(t, r.end); st.bytes -= r.size - r.end; }   // a torn tail from a crash
        st.tsize = r.end;
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
          const n = st.count + add.length;
          if (e.seq <= n) {
            const mine = e.seq <= st.count ? (e.seq === st.count ? st.last : readLines(st, s, e.seq, e.seq)[0]) : add[e.seq - st.count - 1];
            if (mine && mine.line === e.line) continue;                       // the same line again: acknowledged, not stored twice
            if (e.seq <= st.seq) throw err("conflict", "that line is already part of a saved checkpoint");
            // A machine that resumed from the last checkpoint writes over what the dead one added after it.
            if (add.length) throw err("conflict", "lines out of order");
            const cut = offsetOf(st, s, e.seq);
            if (cut === null) throw err("conflict", "that line cannot be replaced");
            const fd = fsx.openSync(t, "r+"); try { fsx.ftruncateSync(fd, cut); fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); }
            st.bytes -= st.tsize - cut; st.tsize = cut; st.count = e.seq - 1; st.idx.length = Math.ceil(st.count / STRIDE);
            st.last = st.count ? readLines(st, s, st.count, st.count)[0] : null;
            add.push({ seq: e.seq, line: e.line }); continue;
          }
          if (e.seq !== n + 1) throw err("gap", "a transcript line is missing before this one");
          add.push({ seq: e.seq, line: e.line });
        }
        const fresh = add.filter(e => e.seq > st.count);
        if (fresh.length) {
          const text = fresh.map(e => JSON.stringify(e) + "\n").join(""), len = Buffer.byteLength(text);
          room(st, len);
          let fd = -1;
          try { fd = fsx.openSync(t, "a", 0o600); fsx.writeSync(fd, text); fsx.fsyncSync(fd); fsx.closeSync(fd); fd = -1; }
          catch (e) { if (fd >= 0) try { fsx.closeSync(fd); } catch {} try { fsx.truncateSync(t, st.tsize); } catch {} throw e; }
          syncDir(dirOf(s));
          let at = st.tsize;
          for (const e of fresh) { if (st.count % STRIDE === 0) st.idx.push(at); at += Buffer.byteLength(JSON.stringify(e)) + 1; st.count++; }
          st.last = fresh[fresh.length - 1]; st.tsize = at; st.bytes += len;
        }
        return { acked: st.count };
      }));
    },
    async getTranscript(chain, s, from = 1, limit = Infinity) {
      await ok(chain, ACTIONS.read, s);
      return serial(s, () => readLines(load(s), s, from, Number.isInteger(limit) && limit > 0 ? from + limit - 1 : Infinity));
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
        if (cp.turn > st.turn + 1) throw err("bad_input", "a checkpoint follows the last one: its turn can be at most one more");
        if (cp.seq < st.seq || cp.seq > st.count) throw err("incomplete", "the transcript does not reach this checkpoint");
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
        appendTranscript: (s, e) => api.appendTranscript(c(), s, e), getTranscript: (s, f, l) => api.getTranscript(c(), s, f, l),
        putFile: (s, rel, b) => api.putFile(c(), s, rel, b), getFile: (s, rel, v) => api.getFile(c(), s, rel, v),
        putCheckpoint: (s, cp) => api.putCheckpoint(c(), s, cp), getCheckpoint: s => api.getCheckpoint(c(), s),
      };
    },
  };
}
