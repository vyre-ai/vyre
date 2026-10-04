// @ts-check
// A session on the person's own server, made as safe as a lent one (docs/work/runner.md "Own-server sessions"). The provider's own transcript
// (`<id>.jsonl`, appended by Claude Code with no fsync) is sealed at every turn into the same checkpoint store a lent session uses, and after a
// crash or power cut `recover` puts the file back to exactly the last whole turn, so `claude --resume` starts from a history that is complete.
//
//   seal({ turn, state })   at a turn's end: only COMPLETE lines (a torn tail is left out), the file fsynced first, the new lines appended to the
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

/**
 * @param {{ port: any, session: string, file: string, fs?: any }} o
 */
export function createTurnSeal(o) {
  const fsx = o.fs || fs;
  /** @type {{ offset: number, seq: number, turn: number } | null} */
  let cur = null;
  let busy = Promise.resolve();
  const serial = fn => { const next = busy.then(fn, fn); busy = next.catch(() => {}); return next; };

  /** The complete lines of the file from a byte offset: text up to the last newline; a half line after it waits. */
  const completeFrom = (buf, offset) => {
    const end = buf.lastIndexOf(10);
    if (end < offset) return { lines: [], next: offset };
    const text = buf.subarray(offset, end + 1).toString("utf8");
    return { lines: text.split("\n").slice(0, -1), next: end + 1 };
  };
  const fsyncFile = file => { const fd = fsx.openSync(file, "r"); try { fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); } };

  /** Where the store is up to, and the byte offset after that many complete lines of the file (null when the file no longer holds them). */
  async function attach(buf) {
    const cp = await o.port.getCheckpoint(o.session);
    if (!cp) return { offset: 0, seq: 0, turn: 0 };
    let offset = 0, n = 0;
    while (n < cp.seq) { const i = buf.indexOf(10, offset); if (i < 0) return null; offset = i + 1; n++; }
    // The lines the store holds must be the file's own lines: a rewritten file (compaction) is not a continuation.
    const held = await o.port.getTranscript(o.session, Math.max(1, cp.seq));
    const last = held.find(e => e.seq === cp.seq);
    if (cp.seq > 0 && last) {
      const start = offset >= 2 ? buf.lastIndexOf(10, offset - 2) + 1 : 0;
      if (buf.subarray(start, offset - 1).toString("utf8") !== last.line) return null;
    }
    return { offset, seq: cp.seq, turn: cp.turn };
  }

  return {
    seal: ({ turn, state } = /** @type {any} */ ({})) => serial(async () => {
      if (!Number.isInteger(turn) || turn < 1) throw err("bad_input", "a turn number is needed");
      let buf;
      try { fsyncFile(o.file); buf = fsx.readFileSync(o.file); } catch (e) { if (e.code === "ENOENT") throw err("not_found", "the session has no transcript yet"); throw e; }
      if (!cur) cur = await attach(buf);
      if (!cur || buf.length < cur.offset) { cur = null; throw err("rewritten", "the provider rewrote this session's history, so it is not sealed as a continuation"); }
      const { lines, next } = completeFrom(buf, cur.offset);
      const entries = lines.map((line, i) => ({ seq: cur.seq + i + 1, line }));
      const seq = cur.seq + entries.length;
      // The transcript first, then the checkpoint that names it. A failure leaves the last checkpoint standing.
      try {
        for (let i = 0; i < entries.length; i += 5000) await o.port.appendTranscript(o.session, entries.slice(i, i + 5000));
        await o.port.putCheckpoint(o.session, { turn, seq, manifest: {}, state });
      } catch (e) { cur = null; throw e; }
      cur = { offset: next, seq, turn };
      return { turn, seq };
    }),

    recover: () => serial(async () => {
      const cp = await o.port.getCheckpoint(o.session);
      if (!cp) return null;
      const held = await o.port.getTranscript(o.session, 1);
      const whole = held.filter(e => e.seq <= cp.seq).sort((a, b) => a.seq - b.seq);
      if (whole.length !== cp.seq || whole.some((e, i) => e.seq !== i + 1)) throw err("incomplete", "the stored transcript does not reach its checkpoint");
      const body = whole.map(e => e.line).join("\n") + (whole.length ? "\n" : "");
      const dir = path.dirname(o.file), tmp = `${o.file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fsx.mkdirSync(dir, { recursive: true });
      let fd = -1;
      try {
        fd = fsx.openSync(tmp, "wx", 0o600); const b = Buffer.from(body); let n = 0;
        while (n < b.length) n += fsx.writeSync(fd, b, n, b.length - n);
        fsx.fsyncSync(fd); fsx.closeSync(fd); fd = -1;
        fsx.renameSync(tmp, o.file);
      } catch (e) { if (fd >= 0) try { fsx.closeSync(fd); } catch {} try { fsx.unlinkSync(tmp); } catch {} throw e; }
      try { const d = fsx.openSync(dir, "r"); try { fsx.fsyncSync(d); } finally { fsx.closeSync(d); } } catch {}
      cur = { offset: Buffer.byteLength(body), seq: cp.seq, turn: cp.turn };
      return { turn: cp.turn, seq: cp.seq, state: cp.state };
    }),
  };
}
