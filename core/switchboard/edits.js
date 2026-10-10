// @ts-check
// Undo per file (R031-53). What a turn did to a file the model edited or wrote is remembered here, as the file was before the turn and a fingerprint of the file after it, and one file can be put back:
// `threads.undo-edit { thread, path }`. It works for any provider whose tool events say a file was edited or written, because it watches the files, not the model. It refuses unless the file still holds
// the turn's result (a hash match, so the person's own later edits are never overwritten), only inside the thread's own folder, and the model's next turn is told. Memory only: after a restart an
// earlier turn's edits can no longer be put back from here (the changes panel hides the button), which the answer says in words.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const KEEP = Object.freeze({ edits: 40, preBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const fail = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

/** The file as it is now, or null when there is none (or it is not a plain file). @param {string} file */
function readNow(file) {
  try { const st = fs.statSync(file); return st.isFile() ? fs.readFileSync(file) : undefined; } catch (e) { return /** @type {any} */ (e).code === "ENOENT" ? null : undefined; }
}

/**
 * @typedef {{ call: string, abs: string, pre: Buffer | null | undefined, post?: string | null, turn: number }} Edit
 * pre: the file before the edit (null: it did not exist; undefined: too big or unreadable, so it cannot be put back)
 */

/** @param {{ cwdOf: (thread: string) => string | null }} o */
export function createEdits({ cwdOf }) {
  /** @type {Map<string, { turn: number, open: Map<string, Edit>, done: Edit[], bytes: number }>} */ const threads = new Map();
  const of = (/** @type {string} */ thread) => { let t = threads.get(thread); if (!t) threads.set(thread, t = { turn: 0, open: new Map(), done: [], bytes: 0 }); if (threads.size > 200) threads.delete(/** @type {string} */ (threads.keys().next().value)); return t; };
  const size = (/** @type {Edit} */ e) => (e.pre ? e.pre.length : 0);
  return {
    /** A tool call began: if it edits or writes a file inside the thread's folder, keep the file as it is. @param {string} thread @param {any} p a thread.tool payload */
    started(thread, p) {
      if (!thread || !p || p.phase !== "started" || !["edit", "write"].includes(String(p.kind)) || typeof p.path !== "string" || !p.path) return;
      const cwd = cwdOf(thread);
      if (!cwd) return;
      const abs = path.resolve(cwd, p.path);
      const now = readNow(abs);
      const pre = now && now.length > KEEP.preBytes ? undefined : now;
      of(thread).open.set(String(p.call || p.id), { call: String(p.call || p.id), abs, pre, turn: of(thread).turn });
    },
    /** The call ended: if it worked, remember the file's fingerprint after it. @param {string} thread @param {any} p */
    finished(thread, p) {
      const t = threads.get(thread), call = p && String(p.call || p.id);
      const e = t && call ? t.open.get(call) : null;
      if (!t || !e) return;
      t.open.delete(call);
      if (p.status !== "completed" || p.error) return;
      const now = readNow(e.abs);
      e.post = now === undefined ? undefined : now === null ? null : sha(now);
      if (e.post === undefined) return;
      t.done.push(e); t.bytes += size(e);
      while (t.done.length > KEEP.edits || t.bytes > KEEP.totalBytes) { const old = /** @type {Edit} */ (t.done.shift()); t.bytes -= size(old); }
    },
    /** The turn ended: edits after this belong to the next. @param {string} thread */
    turnEnded(thread) { const t = threads.get(thread); if (t) t.turn += 1; },
    /** Whether a file has an edit that can still be put back (for the panel's button). @param {string} thread @param {string} file */
    has(thread, file) { const cwd = cwdOf(thread), t = threads.get(thread); return Boolean(cwd && t && t.done.some(e => e.abs === path.resolve(cwd, file))); },
    /**
     * Put one file back as it was before the latest turn that edited it. @param {string} thread @param {string} file
     * @returns {{ path: string, restored: "put back" | "removed" }}
     */
    undo(thread, file) {
      const cwd = cwdOf(thread);
      if (!cwd) throw fail("this session has no folder here, so there is nothing to put back", "unavailable");
      let root;
      try { root = fs.realpathSync(cwd); } catch { throw fail("the session's folder is not here", "unavailable"); }
      const abs = path.resolve(cwd, String(file || ""));
      const inside = (/** @type {string} */ p) => p === root || p.startsWith(root + path.sep);
      let real = abs;
      try { real = fs.realpathSync(abs); } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw fail("that file cannot be read", "unavailable"); real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); }
      if (!inside(real)) throw fail("a file outside the session's folder cannot be put back from here", "denied");
      const t = threads.get(thread);
      const mine = t ? t.done.filter(e => e.abs === abs || e.abs === real) : [];
      if (!t || !mine.length) throw fail("Vyre has no earlier version of that file to put back (it keeps them until it restarts)", "not_found");
      // the latest turn that touched it: from the first edit of that turn to the last
      const turn = mine[mine.length - 1].turn, group = mine.filter(e => e.turn === turn);
      const first = group[0], last = group[group.length - 1];
      if (first.pre === undefined) throw fail("that file was too large to keep, so it cannot be put back from here", "unavailable");
      const now = readNow(abs);
      const hash = now === undefined ? undefined : now === null ? null : sha(now);
      if (hash === undefined || hash !== last.post) throw fail("that file has changed since the turn, so nothing was put back", "conflict");
      if (first.pre === null && now === null) throw fail("that file is not on this machine, so there is nothing to remove here", "unavailable");
      if (first.pre === null) { fs.unlinkSync(abs); } else { fs.writeFileSync(abs, first.pre); }
      for (const e of group) { t.done.splice(t.done.indexOf(e), 1); t.bytes -= size(e); }
      return { path: path.relative(root, real) || path.basename(real), restored: first.pre === null ? "removed" : "put back" };
    },
  };
}

/**
 * Watch a module's thread events and give the person's surface the one tool. `thread` may be a chat's id (the app only knows that): the file is looked for in each of the chat's runs. @param {{ ctx: any,
 *   tool: Function, guard: (caller: string, what: string) => void, queuesFor: (caller: string) => boolean, cwdOf: (thread: string) => string | null, runsOf: (chat: string) => string[],
 *   tell: (thread: string, note: string) => void }} o
 */
export function registerEdits({ ctx, tool, guard, queuesFor, cwdOf, runsOf, tell }) {
  const edits = createEdits({ cwdOf });
  const offs = [
    ctx.events.on("thread.tool", (/** @type {any} */ e) => { try { if (e.payload && e.payload.phase === "started") edits.started(e.thread, e.payload); else edits.finished(e.thread, e.payload); } catch { /* a file that cannot be read is simply not kept */ } }),
    ctx.events.on("thread.finished", (/** @type {any} */ e) => { if (e.thread) edits.turnEnded(e.thread); }),
  ];
  tool("threads.undo-edit", "Put one file the session edited back as it was before its last turn: { thread, path }. Refused if the file changed since, or is outside the session's folder. The session is told on its next turn.",
    { type: "object", required: ["thread", "path"], properties: { thread: { type: "string" }, path: { type: "string" } } },
    async (/** @type {any} */ i, /** @type {{ caller: string }} */ { caller }) => {
      guard(caller, "put a file back");
      if (!queuesFor(caller)) throw fail("only a person's surface puts a file back", "denied");
      const given = String(i.thread || ""), file = String(i.path || "");
      // the run that edited it: the thread named, else (a chat's id) the run of that chat that did
      const run = [given, ...runsOf(given)].find(id => edits.has(id, file)) || given;
      const r = edits.undo(run, file);
      tell(run, `[Vyre: the person undid your last edit to ${r.path}: it is ${r.restored === "removed" ? "removed again (it did not exist before your turn)" : "back as it was before your turn"}. Read it before you change it.]`);
      ctx.events.emit("thread.edit-undone", { path: r.path, restored: r.restored }, { thread: run });
      return r;
    });
  return { has: edits.has, stop() { for (const off of offs) { try { off(); } catch { /* gone */ } } } };
}
