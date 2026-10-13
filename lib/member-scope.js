// @ts-check
// member-scope: which accounts a call may use, shared by the firm-key modules (Google, Microsoft 365). The owner, and a call that carries no person (the home's own modules), keep
// the owner's view. A call for a team member is derived from their OWN attested work email only, or refused. The person comes from the kernel's chain for the call, never from the input.

const denied = m => Object.assign(new Error(m), { code: "denied" });
const EMAIL_DOMAIN = e => String(e || "").toLowerCase().split("@")[1] || "";

/**
 * @param {{ kernel?: any, all: () => any[], memberOf: (id: string) => ({ id: string, email?: string, verified?: boolean } | null | undefined), derive: (all: any[], member: any) => any[] }} d
 * @param {any} meta
 * @returns {Promise<any[] | null>} null: the owner's view; else the member's own
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
  return d.derive(d.all(), rec);
}

const OWNER_LABEL = /^(?:cli|local|capsule)$/;

/**
 * Whether this call is the Space owner's own. Fails closed: a claim must prove a readable chain whose every person hop is the owner; a claimless call passes only on the owner's own
 * local socket labels. Any member, admin or unreadable chain is refused in words. Used where a tool decides whose mailbox the firm key becomes.
 * @param {any} kernel @param {any} meta
 */
export async function requireOwner(kernel, meta) {
  const refuse = () => denied("only the Space owner can set which work email a member's firm-key account acts as");
  const claims = Boolean(meta && (typeof meta.token === "string" || (meta.kernelFacts && typeof meta.kernelFacts === "object")));
  if (!kernel || typeof kernel.chain !== "function") throw refuse();
  if (!claims) { if (OWNER_LABEL.test(String((meta && meta.caller) || ""))) return; throw refuse(); }
  let persons;
  try {
    const c = await kernel.chain(meta);
    persons = (c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id));
  } catch { throw refuse(); }
  if (!persons.length || !kernel.owner || persons.some(p => p !== String(kernel.owner))) throw refuse();
}

/** The reasons an email cannot be attested for a person, or null. @param {{ email: string, person: string, firmKeys: any[], taken: (email: string) => string | null, owner?: string }} d */
export function emailProblem(d) {
  const domains = d.firmKeys.filter(k => k && k.firm).map(k => String(k.domain || EMAIL_DOMAIN(k.email)).toLowerCase());
  if (!domains.length) return "add the firm key first: a work email only means something against a firm Google Workspace key";
  if (!domains.includes(EMAIL_DOMAIN(d.email))) return `that address is outside the firm key's domain (${domains.join(", ")})`;
  const other = d.taken(d.email);
  if (other && other !== d.person) return "that address is already attested for another person";
  return null;
}
