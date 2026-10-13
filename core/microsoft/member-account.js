// @ts-check
// member-account (Microsoft 365): a team member's mailbox from the Space's firm app. Same rules as Google's (core/google/member-account.js): the mailbox is the member's own attested, verified
// work email from the member record, never an input; it must sit inside the firm app's domain; the owner's own accounts are never derived. The derived account carries the vault item NAME
// only. Whether the app can reach that mailbox at all is the tenant's own restriction to the staff group (ApplicationAccessPolicy or RBAC for Applications).

const fail = (msg, code) => Object.assign(new Error(msg), { code });
const domainOf = e => String(e || "").toLowerCase().split("@")[1] || "";

/**
 * @param {any[]} all  microsoft_accounts rows ({ name, domain, auth, base, firm })
 * @param {{ id: string, email?: string, verified?: boolean }} member
 * @param {{ mailbox?: string }} [input]
 */
export function forMember(all, member, input = {}) {
  const email = String((member && member.email) || "").trim().toLowerCase();
  if (!member || !member.id || !email || member.verified !== true) throw fail("your work email is not recorded on this Space, so the firm app cannot act as you", "denied");
  if (input.mailbox !== undefined && String(input.mailbox).trim().toLowerCase() !== email) throw fail("you can only use your own mailbox", "denied");
  const keys = all.filter(a => a && a.firm === true && a.auth && a.auth.type === "m365-app");
  if (!keys.length) throw fail("the owner has not added a firm Microsoft 365 app; connect your own account instead", "no_account");
  const usable = keys.filter(k => domainOf(email) === String(k.domain || "").toLowerCase());
  if (!usable.length) throw fail("your email is outside the firm app's domain", "denied");
  return usable.map(k => ({ name: k.name, email, mailbox: email, member: member.id, auth: { type: "m365-app", item: k.auth.item }, ...(k.base ? { base: k.base } : {}) }));
}
