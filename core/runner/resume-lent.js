// @ts-check
// The server carries on a chat that ran on a person's computer (contracts/lent-spawn.md, runner.md): the home hands `resume(i)` the lender's last acknowledged checkpoint and the lines the
// lender sent up to it; this puts them where the chat's next turn on the server reads them, and nothing else.
//
//   1. the lent transcript up to the checkpoint (whole turns only: the lender checkpoints at a turn's end, so a turn that was cut is not in it) becomes the provider's own transcript of the chat on
//      this server (the place `target` names), written to a temp file, fsynced and renamed in, so the next turn starts from a history that is complete;
//   2. the same lines are sealed into this server's own checkpoint store (ownserver.js createTurnSeal), so a later unclean stop recovers to this turn like any session of the server;
//   3. the files the lent session changed (the checkpoint's manifest) are written into the chat's folder when the file is not there, or is the same; a file the server has that differs is NEVER overwritten
//      and is reported (`conflicts`), because two computers changed it and neither is the person's to lose.
// The cut turn is run again from its start by the chat (the switchboard re-sends the prompt it was waiting on); nothing here repeats a turn or invents one.
//
// Ports (the daemon wires them; tests pass fakes): `target(thread)` -> { file, root, native, cwd } | null  where the provider's transcript of that chat lives on this server;
// `seal(session, space)` -> a createTurnSeal-shaped { seal } for the server's own store, or null; `say(type, payload)` for the person's side.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createTurnSeal } from "./ownserver.js";

const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const PAGE = 2000;
const SAFE_REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]{1,400}$/;

/**
 * @param {{ target: (thread: string) => Promise<{ file: string, root: string, native: string, cwd?: string } | null>, port?: (space: string) => any, say?: (type: string, payload: any) => void, fsx?: typeof fs }} o
 * @returns {(i: any) => Promise<{ resumed: boolean, turn: number, lines: number, files: number, conflicts: string[] }>}
 */
export function createResumeLent(o) {
  const fsx = o.fsx || fs;
  return async function resumeLent(i) {
    const thread = String(i.thread || i.chat || i.session);
    const cp = await i.view.checkpoint();
    // nothing whole was ever acknowledged: there is nothing to carry, and the chat starts its turn again from its prompt
    if (!cp || !Number.isInteger(cp.seq) || cp.seq < 1) return { resumed: false, turn: 0, lines: 0, files: 0, conflicts: [] };
    const tg = await o.target(thread);
    if (!tg) throw err("unavailable", "this server has no transcript place for that chat");
    const lines = /** @type {string[]} */ ([]);
    for (let from = 1; from <= cp.seq; ) {
      const page = await i.view.transcript(from, Math.min(PAGE, cp.seq - from + 1));
      if (!Array.isArray(page) || !page.length) throw err("unavailable", "the lender's transcript is not whole at the home");
      for (const e of page) lines.push(String(e.line));
      from += page.length;
    }
    if (lines.length !== cp.seq) throw err("unavailable", `the lender's transcript holds ${lines.length} lines and its checkpoint says ${cp.seq}`);
    // the provider's own file, whole: a temp file in the same folder, fsynced, renamed in
    const dir = path.dirname(tg.file);
    fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(tg.file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    const fd = fsx.openSync(tmp, "w", 0o600);
    try { fsx.writeSync(fd, lines.join("\n") + "\n"); fsx.fsyncSync(fd); } finally { fsx.closeSync(fd); }
    fsx.renameSync(tmp, tg.file);
    // the server's own store learns the same turn, so a later recover() lands here and not before it
    const port = o.port ? o.port(i.space) : null;
    let turn = Number(cp.turn) || 0;
    if (port) {
      const seal = createTurnSeal({ port, session: tg.native, file: tg.file, root: tg.root });
      const done = await seal.seal({ state: tg.cwd ? { cwd: tg.cwd } : {} });
      turn = done.turn;
    }
    // the files the session changed
    let files = 0; const conflicts = /** @type {string[]} */ ([]);
    const manifest = (cp.manifest && typeof cp.manifest === "object") ? cp.manifest : {};
    if (tg.cwd && typeof i.view.file === "function") {
      for (const [remote, ent] of Object.entries(manifest)) {
        // the manifest names a file by its place in the Space: `files/<path>` is the chat's folder (`home/` is the agent's own state on that computer and stays there)
        if (!remote.startsWith("files/")) continue;
        const rel = remote.slice("files/".length);
        if (!SAFE_REL.test(rel)) continue;
        const dest = path.join(tg.cwd, rel);
        if (!path.resolve(dest).startsWith(path.resolve(tg.cwd) + path.sep)) continue;
        const e = /** @type {any} */ (ent || {});
        if (e.hash === "deleted" || e.version === undefined || e.version === null) continue;
        let bytes; try { bytes = await i.view.file(remote, e.version); } catch { continue; }
        if (!bytes) continue;
        let have = null; try { have = fsx.readFileSync(dest); } catch { /* not there */ }
        if (have && Buffer.compare(have, bytes) === 0) continue;
        if (have) { conflicts.push(rel); continue; }
        fsx.mkdirSync(path.dirname(dest), { recursive: true });
        fsx.writeFileSync(dest, bytes, { flag: "wx", mode: 0o600 });
        files++;
      }
    }
    try { o.say?.("runner.resumed", { thread, session: i.session, turn, lines: lines.length, files, conflicts }); } catch { /* a notice, never a stop */ }
    return { resumed: true, turn, lines: lines.length, files, conflicts };
  };
}
