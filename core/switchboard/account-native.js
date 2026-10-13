// @ts-check
// Which native session id a Claude chat runs under after a move to another Claude account. Accounts that share one HOME have no home of their own (no spawner uid).
import crypto from "node:crypto";
import { usesSpawner } from "../sessions/spawn.js";

/**
 * Claude to another Claude account with no home of its own: the new account starts a fresh session, and the thread id already names a transcript in the shared HOME, which the CLI refuses to open again as new.
 * So it starts under a fresh native id, recorded as a rollover is (nativeOf, the seed chain and the hop back all follow it). The hop back from that account puts the chat on the native id it left, which the HOME
 * still holds and the CLI resumes: a chat with no turn under a fresh id of its own would have nothing for the owner's computer to be given.
 * Writes `kept.native` (and the roll row); touches nothing when the move is not one of these.
 * @param {any} sb @param {{ id: string, rec: any, provider: string, from: string, had: boolean, acct: any, model: string | null, reason: string, kept: any }} o
 */
export function accountNative(sb, { id, rec, provider, from, had, acct, model, reason, kept }) {
  if (provider !== "claude" || from !== "claude" || (usesSpawner() && acct && acct.uid != null)) return;
  const insert = (/** @type {string} */ nativeFrom, /** @type {string} */ nativeTo) => sb.db.prepare("INSERT INTO threads_rolls (thread, at, reason, native_from, native_to, provider, model, turn) VALUES (?,?,?,?,?,?,?,?)").run(id, Date.now(), "account", nativeFrom, nativeTo, provider, model || rec.model || null, Number(rec.turns) || 0);
  const cur = sb.nativeOf(id);
  if (reason === "back") {
    const last = /** @type {any} */ (sb.db.prepare("SELECT reason, native_from, native_to FROM threads_rolls WHERE thread = ? ORDER BY id DESC LIMIT 1").get(id));
    if (last && last.reason === "account" && last.native_to === cur && last.native_from && last.native_from !== cur) { kept.native = last.native_from; insert(cur, last.native_from); return; }
  }
  if (had) return;
  const to = crypto.randomUUID();
  kept.native = to;
  insert(cur, to);
}
