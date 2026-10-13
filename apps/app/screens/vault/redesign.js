// The Vault screen's rules as pure functions: which group an item sits in, its health, the top summary, and the sharing levels (Can use / Can edit, the same words as flows and agents).

/** How long a revealed value stays up. A person clicks Reveal; there is no Touch ID for now, and an assistant never sees a value. */
export const REVEAL_MS = 60_000;
/** How long after Copy the clipboard is emptied. */
export const CLIPBOARD_MS = 30_000;

/** The groups, in the order the list, the sidebar panel and the Add picker show them (one list, so the three agree). */
export const GROUPS = /** @type {const} */ (["AI models", "Email and sending", "Phone and texts", "Google and Microsoft", "Code and hosting", "Messaging", "Logins", "SSH keys", "Secure notes", "Any API key"]);

/** Sharing levels. "use" lets an agent or flow use the item without seeing it; "edit" also lets the person change it. */
export const LEVELS = /** @type {const} */ ({ use: { label: "Can use", help: "Uses it without seeing the value." }, edit: { label: "Can edit", help: "Can also change or replace it." } });

/** @typedef {{ id: string, sp: string, group: string, sharedWithMe?: boolean, name: string, detail: string, secret: string, daysLeft?: number | null, lastUsedDays?: number | null, usedBy: { kind: 'flow'|'agent'|'connection'|'project', name: string }[], shared: { who: string, level: 'use'|'edit' }[] }} VItem */

/** @param {VItem} v @returns {'expiring'|'expired'|'unused'|'ok'} */
export function healthOf(v) {
  if (v.daysLeft != null && v.daysLeft < 0) return "expired";
  if (v.daysLeft != null && v.daysLeft <= 14) return "expiring";
  // undefined: not known yet (the uses have not loaded), so it is not called unused; null: known never used.
  if (v.lastUsedDays === null || (v.lastUsedDays !== undefined && v.lastUsedDays > 90)) return "unused";
  return "ok";
}

export const HEALTH_WORDS = { ok: "Healthy", expiring: "Expiring", expired: "Expired", unused: "Unused" };

/** @param {VItem[]} items @returns {{ total: number, expiring: number, expired: number, unused: number, line: string }} */
export function summaryOf(items) {
  const n = { total: items.length, expiring: 0, expired: 0, unused: 0 };
  for (const v of items) { const h = healthOf(v); if (h !== "ok") n[h]++; }
  const bits = [n.expired && `${n.expired} expired`, n.expiring && `${n.expiring} expiring soon`, n.unused && `${n.unused} unused`].filter(Boolean);
  return { ...n, line: `${n.total} ${n.total === 1 ? "item" : "items"}${bits.length ? ": " + bits.join(", ") : ", all healthy"}` };
}

/** Items shown under a scope ("space" or "mine") and a search, as the GroupedList wants them: each carries its `group`. @param {VItem[]} items @param {'space'|'mine'} scope @param {string} q */
export function visible(items, scope, q = "", nav = ALL) {
  const f = q.trim().toLowerCase();
  return items.filter((v) => (scope === "mine" ? v.sp === "mine" : v.sp !== "mine") && inNav(v, nav) && (!f || v.name.toLowerCase().includes(f) || v.detail.toLowerCase().includes(f) || v.group.toLowerCase().includes(f)));
}

/** What the sidebar panel can pick: everything, one group, what needs a look ("Expiring": expiring or expired), or what others shared in ("Shared with me"). @typedef {{ kind: 'all' } | { kind: 'group', group: string } | { kind: 'expiring' } | { kind: 'shared' }} Nav */
/** @type {Nav} */
export const ALL = { kind: "all" };

/** @param {VItem} v @param {Nav} nav */
export function inNav(v, nav) {
  if (nav.kind === "group") return v.group === nav.group;
  if (nav.kind === "expiring") { const h = healthOf(v); return h === "expiring" || h === "expired"; }
  if (nav.kind === "shared") return Boolean(v.sharedWithMe);
  return true;
}

/** The counts the panel shows for the items of one scope: all, each group, expiring, shared with me. @param {VItem[]} items */
export function navCounts(items) {
  /** @type {Record<string, number>} */ const groups = {};
  for (const g of GROUPS) groups[g] = items.filter((v) => v.group === g).length;
  return { all: items.length, groups, expiring: items.filter((v) => inNav(v, { kind: "expiring" })).length, shared: items.filter((v) => v.sharedWithMe).length };
}

/** The words for an empty page under a panel pick. @param {Nav} nav */
export function navEmpty(nav) {
  return nav.kind === "group" ? `Nothing in ${nav.group} yet.` : nav.kind === "expiring" ? "Nothing is expiring." : nav.kind === "shared" ? "Nobody has shared an item with you." : "";
}

/** The groups that have items, in order (the list shows no empty group). @param {VItem[]} items */
export const groupsOf = (items) => GROUPS.filter((g) => items.some((v) => v.group === g)).map((name) => ({ name }));

/** What Delete would break: the flows, agents, connections and projects that use the item, in words. @param {VItem} v */
export function breakage(v) {
  if (!v.usedBy.length) return "Nothing uses it.";
  const by = (/** @type {string} */ k) => v.usedBy.filter((u) => u.kind === k).map((u) => u.name);
  const parts = [["flow", "flows"], ["agent", "agents"], ["connection", "connections"], ["project", "projects"]].map(([k, w]) => by(k).length ? `${by(k).length} ${by(k).length === 1 ? k : w} (${by(k).join(", ")})` : "").filter(Boolean);
  return `Deleting it stops ${parts.join(", ")}.`;
}

/** Share or change a level; sharing again replaces the level, never doubles the row. @param {VItem[]} items */
export const share = (items, id, who, level) => items.map((v) => (v.id === id ? { ...v, shared: [...v.shared.filter((s) => s.who !== who), { who, level }] } : v));
export const unshare = (items, id, who) => items.map((v) => (v.id === id ? { ...v, shared: v.shared.filter((s) => s.who !== who) } : v));

/** Which group each catalog provider's item sits in (core/vault/providers.js names). The Add picker uses the same table, so what you add lands where the list looks for it. @type {Record<string, typeof GROUPS[number]>} */
export const PROVIDER_GROUP = {
  anthropic: "AI models", "claude-setup-token": "AI models", openai: "AI models", deepgram: "AI models", elevenlabs: "AI models",
  "imap-smtp": "Email and sending", "sending-service": "Email and sending",
  twilio: "Phone and texts",
  "google-oauth": "Google and Microsoft", "google-dwd": "Google and Microsoft", "google-apps-script": "Google and Microsoft",
  github: "Code and hosting", "github-oauth": "Code and hosting", cloudflare: "Code and hosting", tailscale: "Code and hosting", "mcp-bearer": "Code and hosting", dropbox: "Code and hosting",
  telegram: "Messaging",
};

/**
 * The group a stored item sits in: the provider it was added from (details.provider) first, then its kind, then words in its name, else "Any API key".
 * @param {string} kind @param {string} name @param {string} [provider]
 */
export function groupOf(kind, name = "", provider = "") {
  const n = name.toLowerCase();
  if (provider && Object.hasOwn(PROVIDER_GROUP, provider)) return PROVIDER_GROUP[provider];
  if (kind === "login" || kind === "card" || kind === "identity" || kind === "authenticator" || kind === "passkey") return "Logins";
  if (kind === "ssh-key") return "SSH keys";
  if (kind === "note") return "Secure notes";
  if (kind === "mcp-connection" || kind === "mail" || kind === "calendar" || /^mcp[-_.]/.test(n)) return kind === "mail" || kind === "calendar" ? "Google and Microsoft" : "Code and hosting";
  if (/anthropic|claude|openai|deepgram|eleven/.test(n)) return "AI models";
  if (/resend|smtp|imap|sendgrid|mailgun|postmark|ses[-_.]|sending/.test(n)) return "Email and sending";
  if (/twilio|sms|phone|voip/.test(n)) return "Phone and texts";
  if (/google|gmail|apps-script|microsoft|outlook|office365/.test(n)) return "Google and Microsoft";
  if (/github|cloudflare|tailscale|railway|vercel|mcp/.test(n)) return "Code and hosting";
  if (/telegram|slack|discord|whatsapp/.test(n)) return "Messaging";
  return "Any API key";
}

/** Days from `now` to an ISO date or ms time, negative when past; null when there is none. @param {string | number | undefined | null} expires @param {number} now */
export function daysLeftOf(expires, now = Date.now()) {
  if (expires === undefined || expires === null || expires === "") return null;
  const t = typeof expires === "number" ? expires : Date.parse(String(expires));
  return Number.isFinite(t) ? Math.floor((t - now) / 86_400_000) : null;
}

/** The field to reveal for an item: the secret-like one first. @param {string[]} fields */
export const valueField = (fields) => ["secret", "value", "password", "token", "key", "api_key"].find((f) => fields.includes(f)) ?? fields[0] ?? "value";
