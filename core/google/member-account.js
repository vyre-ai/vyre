// @ts-check
// member-account: a team member's Google account from the Space's firm key (owner decision 00:57Z, route c).
//
// The owner adds a Workspace service account with domain-wide delegation once, marked `firm`. A member gets an
// account derived from it whose `subject` is the member's OWN verified email and nobody else's. Rules, and why:
// - The mailbox comes from the member's record in the kernel, never from the input: an input `mailbox` may only
//   repeat the member's own address, anything else is refused (the firm key can act as anyone in the domain).
// - The email must be verified and inside the firm key's domain (its `domain`, else the key's own address domain).
// - Only `firm` rows are ever derived; the owner's own accounts are never handed to a member.
// - The derived account carries the vault item NAME only, as every account does; nothing secret is held here.

const fail = (msg, code) => Object.assign(new Error(msg), { code });
const domainOf = e => String(e || "").toLowerCase().split("@")[1] || "";

/**
 * @param {any[]} all  google_accounts rows
 * @param {{ id: string, email?: string, verified?: boolean }} member  the member's kernel record
 * @param {{ mailbox?: string }} [input]
 * @returns {any[]}
 */
export function forMember(all, member, input = {}) {
  const email = String((member && member.email) || "").trim().toLowerCase();
  if (!member || !member.id || !email || member.verified !== true) throw fail("your email is not verified on this Space, so the firm key cannot act as you", "denied");
  if (input.mailbox !== undefined && String(input.mailbox).trim().toLowerCase() !== email) throw fail("you can only use your own mailbox", "denied");
  const keys = all.filter(a => a && a.firm === true && a.auth && a.auth.type === "service-account");
  if (!keys.length) throw fail("the owner has not added a firm Google Workspace key; connect your own account instead", "no_account");
  const usable = keys.filter(k => domainOf(email) === String(k.domain || domainOf(k.email)).toLowerCase());
  if (!usable.length) throw fail("your email is outside the firm key's domain", "denied");
  return usable.map(k => ({ name: `${k.name}:${member.id}`.slice(0, 64), email, auth: { type: "service-account", item: k.auth.item, subject: email }, ...(k.base ? { base: k.base } : {}), added: k.added || 0 }));
}
