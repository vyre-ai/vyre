// @ts-check
// Continuous sync and checkpoints (DESIGN-local-runner section 4). Nothing lives only on this machine.
//
// The space is the source of truth. This computer keeps a working copy inside the encrypted workspace:
//   <mnt>/work/files        the space's files the session works on (its cwd)
//   <mnt>/work/home         the agent's HOME (its own state, such as Claude Code's session files)
//   <mnt>/state/<session>   the runner's own copy of the transcript, the outbox and the last checkpoint. The sandbox is given
//                           <mnt>/work only, so the session can never edit its own bookkeeping.
//
// The session writes into work/, so the runner treats everything in it as hostile (safefs.js): no link is followed, only plain
// files inside the root are read, restores go through a temp file and a rename, and the runner stops the session's process group
// while it reads (runner.js) so nothing changes under it.
//
// Per line, the transcript goes to the space as it happens. At every turn end the runner CHECKPOINTS: it flushes the
// transcript, uploads every file that changed since the last checkpoint as a new version (two machines editing the
// same file produce two versions, never a merge dialog), then records { turn, seq, manifest } with the space. A
// checkpoint exists only once the space has acknowledged it, so a machine that dies mid-turn resumes elsewhere from
// the last turn the space really holds.
//
// The space is a port (see testing/fake-space.js for the shape):
//   appendTranscript(session, entries[{ seq, line }])        -> { acked: seq }
//   putFile(session, rel, bytes, { base })                   -> { version }
//   putCheckpoint(session, { turn, seq, manifest, state })   -> { ok: true }
//   getCheckpoint(session)                                   -> { turn, seq, manifest, state } | null
//   getTranscript(session, fromSeq)                          -> [{ seq, line }]
//   getFile(session, rel, version)                           -> Buffer

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readInside, listInside, writeInside, parts, plantable } from "./safefs.js";

/** The folders the sync carries, relative to the mounted workspace, and where each lands in the space. */
export const ROOTS = [
  { dir: "files", remote: "files" },
  { dir: "home/.claude", remote: "agent/claude" },
];
const SKIP = new Set([".git/index.lock"]);
const MAX_FILE = 100 * 1024 * 1024;

const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
/** What a checkpoint's seal must cover: the manifest and the transcript up to seq, so a forged file or history is not resumed as the session's own. */
const canon = m => JSON.stringify(Object.keys(m).sort().map(k => [k, m[k].hash, m[k].version]));
const transcriptHash = (lines, seq) => sha(lines.filter(e => e.seq <= seq).sort((a, b) => a.seq - b.seq).map(e => `${e.seq}:${e.line}\n`).join(""));
export const coverOf = (manifest, lines, seq, turn) => ({ turn, seq, manifest: sha(canon(manifest)), transcript: transcriptHash(lines, seq) });

/** Disk-full and quota errors become one plain refusal. */
const full = e => ["ENOSPC", "EDQUOT"].includes(e?.code);
const refusal = e => full(e) ? Object.assign(new Error("this computer's disk is full, so the session's progress cannot be saved here"), { code: "disk_full" }) : e;
/** Write a file so a reader sees the old whole file or the new whole file, never half of one: temp file, fsync, rename, fsync of the folder. A failure leaves no temp file. */
export function atomicWrite(file, data, fsx = fs) {
  const tmp = `${file}.tmp-${process.pid}`;
  let fd = -1;
  try {
    fd = fsx.openSync(tmp, "w", 0o600);
    fsx.writeSync(fd, data);
    fsx.fsyncSync(fd);
    fsx.closeSync(fd); fd = -1;
    fsx.renameSync(tmp, file);
  } catch (e) {
    if (fd >= 0) try { fsx.closeSync(fd); } catch {}
    try { fsx.unlinkSync(tmp); } catch {}
    throw refusal(e);
  }
  try { const d = fsx.openSync(path.dirname(file), "r"); try { fsx.fsyncSync(d); } finally { fsx.closeSync(d); } } catch {}
}
/** The complete lines of the transcript file. A torn last line (a crash or a full disk in the middle of an append) is cut off. */
function readTranscript(file, fsx = fs) {
  let text; try { text = fsx.readFileSync(file, "utf8"); } catch { return []; }
  const out = []; let good = 0, pos = 0;
  for (const l of text.split("\n")) {
    const end = pos + l.length + 1; pos = end;
    if (!l) { good = Math.min(end, text.length); continue; }
    if (end > text.length) break;   // no newline after it: torn
    try { const e = JSON.parse(l); if (typeof e?.seq === "number") { out.push(e); good = end; } } catch { break; }
  }
  if (good < text.length) { try { fsx.truncateSync(file, Buffer.byteLength(text.slice(0, good))); } catch {} }
  return out;
}

/** @typedef {(req: { roots: typeof ROOTS, have: Record<string, { hash: string, size: number, mtimeMs: number }>, maxBytes?: number }, onFile: (f: { rel: string, hash: string, size: number, len: number, mtimeMs: number, bytes: Buffer|null, deferred?: boolean }) => Promise<void>) => Promise<{ truncated: boolean }>} Reader */

/**
 * A reader that runs in THIS process, for tests of a workspace nobody else writes to. Production uses readerhost.js, which reads from
 * inside the sandbox so a link or a race can never reach a host file.
 * @param {string} work @returns {Reader}
 */
export const localReaderFor = work => async ({ roots, have, maxBytes = 1e8 }, onFile) => {
  for (const root of roots) for (const rel of listInside(work, root.dir)) {
    const bytes = readInside(work, rel, maxBytes); if (!bytes) continue;
    const hash = sha(bytes), same = have[rel]?.hash === hash, st = fs.statSync(path.join(work, rel));
    await onFile({ rel, hash, size: same ? 0 : bytes.length, len: bytes.length, mtimeMs: st.mtimeMs, bytes: same ? null : bytes });
  }
  return { truncated: false };
};

/**
 * @param {{ space: any, session: string, work: string, state: string, reader: Reader, seal: (state: any) => any, roots?: typeof ROOTS, log?: (m: string) => void }} o
 */
export function createSessionSync(o) {
  const roots = o.roots || ROOTS;
  const fsx = o.fs || fs;
  const meta = path.join(o.state, o.session);
  fs.mkdirSync(meta, { recursive: true, mode: 0o700 });
  // A temp file left by a process that was killed mid-write is not part of anything: remove it.
  try { for (const f of fs.readdirSync(meta)) if (/\.tmp-\d+$/.test(f)) fs.rmSync(path.join(meta, f), { force: true }); } catch {}
  const tFile = path.join(meta, "transcript.jsonl");
  const cFile = path.join(meta, "checkpoint.json");
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

  let seq = 0, acked = 0, turn = 0, /** @type {string|null} */ refused = null;
  /** manifest of what the space holds: remote path -> { hash, version } */
  let manifest = readJson(cFile, { manifest: {} }).manifest || {};
  /** transcript lines not yet acknowledged by the space (the outbox), kept in the workspace so a restart resends them */
  const outbox = [];
  {
    const lines = readTranscript(tFile);
    for (const e of lines) seq = Math.max(seq, e.seq);
    acked = readJson(cFile, { seq: 0 }).seq || 0;
    for (const e of lines) if (e.seq > acked) outbox.push(e);
    turn = readJson(cFile, { turn: 0 }).turn || 0;
  }

  async function flush() {
    if (!outbox.length) return true;
    try {
      const r = await o.space.appendTranscript(o.session, outbox.map(e => ({ seq: e.seq, line: e.line })));
      const upTo = Number(r?.acked ?? outbox[outbox.length - 1].seq);
      acked = Math.max(acked, upTo);
      while (outbox.length && outbox[0].seq <= acked) outbox.shift();
      return outbox.length === 0;
    } catch (e) { o.log?.("transcript send failed, kept in the outbox"); return false; }
  }

  async function syncFiles() {
    // The files are read by a reader running inside the session's own sandbox (reader.js), never by this process, and handled one at a
    // time as each arrives. Total bytes, file count and time are capped by the reader host.
    const have = {};
    for (const [remote, m] of Object.entries(manifest)) { const root = roots.find(r => remote.startsWith(r.remote + "/")); if (root && m.hash !== "deleted") have[root.dir + "/" + remote.slice(root.remote.length + 1)] = { hash: m.hash, size: m.len, mtimeMs: m.mtimeMs }; }
    const seen = new Set();
    const { truncated } = await o.reader({ roots, have, maxBytes: MAX_FILE }, async f => {
      const root = roots.find(r => f.rel.startsWith(r.dir + "/"));
      if (!root) return;
      const remote = `${root.remote}/${f.rel.slice(root.dir.length + 1)}`;
      seen.add(remote);
      if (f.deferred) return;   // modified in the last second: next checkpoint (and not a deletion)
      const have0 = manifest[remote];
      if (!f.bytes) { if (have0 && have0.hash === f.hash && have0.mtimeMs !== f.mtimeMs) have0.mtimeMs = f.mtimeMs; return; }
      if (have0 && have0.hash === f.hash) { have0.mtimeMs = f.mtimeMs; have0.len = f.len; return; }
      const r = await o.space.putFile(o.session, remote, f.bytes, { base: have0 ? have0.version : 0 });
      manifest[remote] = { hash: f.hash, version: r.version, len: f.len, mtimeMs: f.mtimeMs };
    });
    // Over the caps the checkpoint is refused rather than recorded with files missing (a half-read tree would tombstone real files).
    if (truncated) throw new Error("the workspace is over the checkpoint limits");
    // A file removed here is recorded as removed in the space (a tombstone version), not silently kept.
    for (const remote of Object.keys(manifest)) {
      if (!seen.has(remote) && manifest[remote].hash !== "deleted") {
        const r = await o.space.putFile(o.session, remote, null, { base: manifest[remote].version });
        manifest[remote] = { hash: "deleted", version: r.version };
      }
    }
  }

  return {
    get seq() { return seq; },
    get turn() { return turn; },
    get acked() { return acked; },
    /** One transcript line from the session process: written locally (encrypted at rest) and queued for the space. */
    async line(line) {
      const e = { seq: seq + 1, line };
      let size = 0; try { size = fsx.statSync(tFile).size; } catch {}
      try { fsx.appendFileSync(tFile, JSON.stringify(e) + "\n", { mode: 0o600 }); }
      catch (err) {
        // A full disk leaves no half line and no gap in the numbers: cut the file back to what it was and refuse this line.
        try { fsx.truncateSync(tFile, size); } catch {}
        throw refusal(err);
      }
      seq = e.seq;
      outbox.push(e);
      if (outbox.length >= 20) await flush();
    },
    /** A turn ended: flush, upload changed files, record the checkpoint with the space. Returns true once acknowledged. */
    async checkpoint(state = {}) {
      refused = null;
      const sent = await flush();
      if (!sent) return false;
      try {
        // The transcript is on this disk, not only in the page cache, before the space is told the checkpoint exists.
        try { const fd = fsx.openSync(tFile, "r"); try { fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); } } catch (e) { if (e?.code !== "ENOENT") throw refusal(e); }
        await syncFiles();
        const all = readTranscript(tFile, fsx);
        const cp = { turn: turn + 1, seq, manifest, state: o.seal({ ...state, cover: coverOf(manifest, all, seq, turn + 1) }) };
        await o.space.putCheckpoint(o.session, cp);
        turn = cp.turn;
        // The space holds the checkpoint now. If this computer cannot record that (disk full) the checkpoint still stands; the next
        // start resends what the space already has, which it ignores.
        try { atomicWrite(cFile, JSON.stringify(cp), fsx); } catch (e) { o.log?.("checkpoint kept by the space, not recorded here: " + e.message); }
        return true;
      } catch (e) { refused = e?.code === "disk_full" || full(e) ? "disk_full" : null; o.log?.("checkpoint not acknowledged: " + e.message); return false; }
    },
    /** Why the last checkpoint was refused here, when it was this computer's doing: "disk_full", else null. */
    get refused() { return refused; },
    flush,
  };
}

/**
 * Restore a session from the space's last checkpoint into a workspace: the transcript, the files, the agent's home. Used to
 * resume on another machine or after this one lost its workspace. Run it BEFORE the session starts. Every path in the manifest
 * is checked and written through safefs, so a path that climbs out or a link planted earlier writes nothing outside work/.
 * @param {{ space: any, session: string, work: string, state: string, roots?: typeof ROOTS, verify: (state: any) => boolean }} o
 * @returns {Promise<{ turn: number, seq: number, state: any } | null>}
 */
export async function restore(o) {
  const roots = o.roots || ROOTS;
  const cp = await o.space.getCheckpoint(o.session);
  if (!cp) return null;
  // A checkpoint is never resumed unverified: the seal must verify, and it must cover THIS manifest and THIS transcript.
  if (typeof o.verify !== "function") throw Object.assign(new Error("there is no way to verify a checkpoint, so it is not resumed"), { code: "bad_checkpoint" });
  const bad = () => Object.assign(new Error("the checkpoint's seal does not verify"), { code: "bad_checkpoint" });
  if (!o.verify(cp.state)) throw bad();
  const meta = path.join(o.state, o.session);
  fs.mkdirSync(meta, { recursive: true, mode: 0o700 });
  const lines = await o.space.getTranscript(o.session, 1);
  const want = cp.state?.cover, got = coverOf(cp.manifest || {}, lines, cp.seq, cp.turn);
  if (!want || want.manifest !== got.manifest || want.transcript !== got.transcript || want.seq !== cp.seq || want.turn !== cp.turn) throw bad();
  const kept = lines.filter(e => e.seq <= cp.seq);
  atomicWrite(path.join(meta, "transcript.jsonl"), kept.map(e => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""));
  let refused = 0;
  for (const [remote, m] of Object.entries(cp.manifest || {})) {
    const root = roots.find(r => remote.startsWith(r.remote + "/"));
    if (!root || m.hash === "deleted") continue;
    let rel; try { rel = parts(remote.slice(root.remote.length + 1)).join("/"); } catch { continue; }
    // What comes back from another computer is an ALLOWLIST: the work files, and the provider's transcripts (projects/<folder>/<session>.jsonl). Nothing else of that computer's agent home: a settings file, a hook, an MCP
    // server list or an instructions file written there would run on the next computer, or the box, with this session's authority (trust row 17).
    if (root.dir === "files" && plantable(rel)) { refused++; continue; }   // the work folder's own settings, hooks, MCP list and instructions are not brought back either (row 29)
    if (root.dir !== "files" && !(root.dir === "home/.claude" && /^projects\/[^/]+\/[A-Za-z0-9_-]{1,100}\.jsonl$/.test(rel))) { refused++; continue; }
    // A link planted in the workspace refuses that one file (and is counted), it never redirects the write.
    try { writeInside(o.work, `${root.dir}/${rel}`, Buffer.from(await o.space.getFile(o.session, remote, m.version))); } catch (e) { if (!/unsafe_path|EEXIST|ENOTDIR|ELOOP/.test(String(e.code))) throw refusal(e); refused++; }
  }
  atomicWrite(path.join(meta, "checkpoint.json"), JSON.stringify(cp));
  return { turn: cp.turn, seq: cp.seq, state: cp.state };
}
