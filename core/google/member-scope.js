// @ts-check
// member-scope: which Google accounts a call may use. The owner, and a call that carries no person (the home's own modules), see every
// account, as before. A call for a team member sees only their own mailbox from the firm key (member-account.js), or is refused.
// The person comes from the kernel's chain for the call, never from the input.
import { forMember } from "./member-account.js";

const denied = m => Object.assign(new Error(m), { code: "denied" });

/**
 * @param {{ kernel?: any, all: () => any[], memberOf: (id: string) => ({ id: string, email?: string, verified?: boolean } | null | undefined) }} d
 * @param {any} meta
 * @returns {Promise<any[] | null>} null: every account; else the member's own
 */
export async function scopeFor(d, meta) {
  const k = d.kernel;
  const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
  if (!k || typeof k.chain !== "function" || !claims) return null;
  let persons;
  try {
    const c = await k.chain(meta);
    persons = (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
  } catch { throw denied("who is asking could not be read, so no account is offered"); }
  const other = persons.filter(p => p !== String(k.owner));
  if (!other.length) return null;
  const rec = d.memberOf(other[other.length - 1]);
  if (!rec) throw denied("this Space has no work email recorded for you, so the firm key cannot act as you");
  return forMember(d.all(), rec);
}
