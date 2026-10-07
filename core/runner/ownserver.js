// @ts-check
// A session on the person's own server, made as safe as a lent one (team/archive/work-journals/runner.md "Own-server sessions"). The provider's own transcript
// (`<id>.jsonl`, appended by Claude Code with no fsync) is sealed at every turn into the same checkpoint store a lent session uses, and after a
// crash or power cut `recover` puts the file back to exactly the last whole turn, so `claude --resume` starts from a history that is complete.
//
//   seal({ state })         at a turn's end (the turn number is the store's last plus one, never a caller's number): only COMPLETE lines (a torn tail is left out), the file fsynced first, the new lines appended to the
//                           store, then the checkpoint written (the commit). Returns { turn, seq }.
//   recover()               the file rewritten (temp, fsync, rename) to the lines of the last checkpoint, the unfinished turn and any torn line
//                           dropped. Returns { turn, seq, state } or null when nothing was ever sealed.
//
// One mechanism: the port is the checkpoint store's own (core/runner/checkpoint-store.js `port(chain)`), so a session can move between the own
// server and a lent computer. Project files on the server are the server's own disk and are not versioned here (manifest is empty).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const err = (code, message) => Object.assign(new Error(message), { code });
const SESSION = /^[A-Za-z0-9_-]{1,100}$/;

const CHUNK = 4 * 1024 * 1024, BATCH = 5000;

/**
 * @param {{ port: any, session: string, file: string, root: string, fs?: any }} o `root` is the provider's own projects folder; the file must be `<root>/<project>/<session>.jsonl`.
 */
export function createTurnSeal(o) {
  const fsx = o.fs || fs;
  /** @type {{ offset: number, seq: number, turn: number } | null} */
  let cur = null;
  let busy = Promise.resolve();
  const serial = fn => { const next = busy.then(fn, fn); busy = next.catch(() => {}); return next; };

  /** The file must be the provider's own transcript of THIS session and nothing else: never read or overwrite another path, a link or another session's file (reviewer-2 RN-3). */
  function pin() {
    const refuse = why => err("refused", `not this session's own transcript: ${why}`);
    if (!SESSION.test(String(o.session))) throw refuse("the session name");
    if (typeof o.file !== "string" || typeof o.root !== "string" || !path.isAbsolute(o.file) || path.resolve(o.file) !== o.file) throw refuse("the path");
    if (path.basename(o.file) !== `${o.session}.jsonl`) throw refuse("the file name");
    let root; try { root = fsx.realpathSync(o.root); } catch { throw refuse("the projects folder"); }
    const dir = path.dirname(o.file);
    if (path.dirname(dir) !== root) throw refuse("the folder");
    try { if (fsx.realpathSync(dir) !== dir) throw 0; } catch { throw refuse("the project folder is a link or missing"); }
    let st = null; try { st = fsx.lstatSync(o.file); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (st && (!st.isFile() || st.isSymbolicLink())) throw refuse("not a plain file");
    let ds = null; try { ds = fsx.lstatSync(dir); } catch { throw refuse("the project folder is missing"); }
    return { file: st, dir: ds };
  }
  /** The folder is still the one that was checked (same device and inode, not a link): the session can write its own projects folder and could swap it between the check and the use. */
  function sameDir(was) {
    let now; try { now = fsx.lstatSync(path.dirname(o.file)); } catch { throw err("refused", "not this session's own transcript: the project folder changed"); }
    if (now.isSymbolicLink() || now.dev !== was.dev || now.ino !== was.ino) throw err("refused", "not this session's own transcript: the project folder changed");
  }
  const readAt = (fd, pos, len) => { const b = Buffer.allocUnsafe(len); let n = 0; while (n < len) { const r = fsx.readSync(fd, b, n, len - n, pos + n); if (!r) break; n += r; } return b.subarray(0, n); };

  /** Where the store is up to, and the byte offset after that many complete lines of the file, found by streaming (null when the file no longer holds them or its last held line differs). */
  async function attach(fd, size) {
    const cp = await o.port.getCheckpoint(o.session);
    if (!cp) return { offset: 0, seq: 0, turn: 0 };
    let n = 0, pos = 0, lineStart = 0, prevStart = 0;
    while (n < cp.seq && pos < size) {
      const b = readAt(fd, pos, Math.min(CHUNK, size - pos)); if (!b.length) break;
      let i = -1, from = 0;
      while (n < cp.seq && (i = b.indexOf(10, from)) >= 0) { n++; prevStart = lineStart; lineStart = pos + i + 1; from = i + 1; }
      pos += b.length;
    }
    if (n < cp.seq) return null;
    if (cp.seq > 0) {
      const held = (await o.port.getTranscript(o.session, cp.seq)).find(e => e.seq === cp.seq);
      if (!held || readAt(fd, prevStart, lineStart - 1 - prevStart).toString("utf8") !== held.line) return null;
    }
    return { offset: lineStart, seq: cp.seq, turn: cp.turn };
  }

  return {
    /** @param {{ state?: any }} [a] */
    seal: ({ state } = {}) => serial(async () => {
      const pinned = pin();
      let fd;
      // Opened without following a link, then the descriptor itself is checked against what pin() saw: whatever the path points at now, only that very file is read (reviewer-2 RN-3b).
      try { fd = fsx.openSync(o.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { if (e.code === "ENOENT") throw err("not_found", "the session has no transcript yet"); if (e.code === "ELOOP") throw err("refused", "not this session's own transcript: it is a link"); throw e; }
      try {
        const fst = fsx.fstatSync(fd);
        if (!fst.isFile() || (pinned.file && (fst.dev !== pinned.file.dev || fst.ino !== pinned.file.ino))) throw err("refused", "not this session's own transcript: the file changed");
        sameDir(pinned.dir);
        fsx.fsyncSync(fd);                                            // what the provider wrote is on disk before the store says it holds it
        const size = fsx.fstatSync(fd).size;
        if (!cur) cur = await attach(fd, size);
        if (!cur || size < cur.offset) { cur = null; throw err("rewritten", "the provider rewrote this session's history, so it is not sealed as a continuation"); }
        let { offset, seq } = cur, chunk = CHUNK;
        // The transcript first, one bounded slice at a time, then the checkpoint that names it. A failure leaves the last checkpoint standing.
        try {
          while (offset < size) {
            const b = readAt(fd, offset, Math.min(chunk, size - offset));
            const end = b.lastIndexOf(10);
            if (end < 0) { if (offset + b.length >= size) break; chunk *= 2; continue; }   // a half line at the end waits; a very long line needs a bigger slice
            chunk = CHUNK;
            const lines = b.subarray(0, end + 1).toString("utf8").split("\n").slice(0, -1);
            for (let i = 0; i < lines.length; i += BATCH) await o.port.appendTranscript(o.session, lines.slice(i, i + BATCH).map((line, j) => ({ seq: seq + i + j + 1, line })));
            seq += lines.length; offset += end + 1;
          }
          if (seq === cur.seq && cur.turn > 0) return { turn: cur.turn, seq, unchanged: true };   // the same turn twice: already sealed
          const turn = cur.turn + 1;
          await o.port.putCheckpoint(o.session, { turn, seq, manifest: {}, state });
          cur = { offset, seq, turn };
          return { turn, seq };
        } catch (e) { cur = null; throw e; }
      } finally { fsx.closeSync(fd); }
    }),

    recover: () => serial(async () => {
      const pinned = pin();
      const cp = await o.port.getCheckpoint(o.session);
      if (!cp) return null;
      const dir = path.dirname(o.file), tmp = `${o.file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fsx.mkdirSync(dir, { recursive: true });
      let fd = -1, n = 0, bytes = 0;
      try {
        sameDir(pinned.dir);
        fd = fsx.openSync(tmp, "wx", 0o600);
        // The stored lines up to the checkpoint, written as they are read, never all held at once.
        for (let from = 1; from <= cp.seq;) {
          const part = (await o.port.getTranscript(o.session, from, BATCH)).filter(e => e.seq <= cp.seq);
          if (!part.length) break;
          for (const e of part) { if (e.seq !== n + 1) throw err("incomplete", "the stored transcript does not reach its checkpoint"); const b = Buffer.from(e.line + "\n"); let w = 0; while (w < b.length) w += fsx.writeSync(fd, b, w, b.length - w); bytes += b.length; n++; }
          from = n + 1;
        }
        if (n !== cp.seq) throw err("incomplete", "the stored transcript does not reach its checkpoint");
        fsx.fsyncSync(fd); fsx.closeSync(fd); fd = -1;
        sameDir(pinned.dir);                                            // checked again just before the rename: a swapped folder is never written into
        // A transcript that belongs to another uid (the packaged box: the account's own file, made group-writable for vyred by the spawner) is rewritten IN PLACE, not replaced: a renamed file would be
        // vyred's own, and the session's uid could neither read nor append to it. A crash in the middle just runs recover again (the checkpoint is the truth); the common case keeps the atomic rename.
        let foreign = false; try { foreign = typeof process.getuid === "function" && fsx.lstatSync(o.file).uid !== process.getuid(); } catch { /* no file yet */ }
        if (foreign) {
          // The folders above the file belong to the session's uid, so a link could be swapped in after the earlier checks: right before the write the folder is the pinned one, the file's real path is its
          // own, and its owner is the owner of its folder (the account's uid), or nothing is written.
          sameDir(pinned.dir);
          if (fsx.realpathSync(o.file) !== o.file || fsx.lstatSync(o.file).uid !== fsx.lstatSync(dir).uid) throw err("refused", "the transcript is not the account's own file in its own folder");
          const src = fsx.openSync(tmp, "r"), dst = fsx.openSync(o.file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
          try {
            const size = fsx.fstatSync(src).size, buf = Buffer.alloc(1 << 16); let off = 0;
            while (off < size) { const r = fsx.readSync(src, buf, 0, Math.min(buf.length, size - off), off); if (r <= 0) break; let w = 0; while (w < r) w += fsx.writeSync(dst, buf, w, r - w, off + w); off += r; }
            fsx.ftruncateSync(dst, size); fsx.fsyncSync(dst);
          } finally { fsx.closeSync(src); fsx.closeSync(dst); }
          fsx.unlinkSync(tmp);
        } else fsx.renameSync(tmp, o.file);
      } catch (e) { if (fd >= 0) try { fsx.closeSync(fd); } catch {} try { fsx.unlinkSync(tmp); } catch {} throw e; }
      try { const d = fsx.openSync(dir, "r"); try { fsx.fsyncSync(d); } finally { fsx.closeSync(d); } } catch {}
      cur = { offset: bytes, seq: cp.seq, turn: cp.turn };
      return { turn: cp.turn, seq: cp.seq, state: cp.state };
    }),
  };
}
