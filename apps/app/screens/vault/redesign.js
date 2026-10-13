// The Vault screen's rules as pure functions: which group an item sits in, its health, the top summary, and the sharing levels (Can use / Can edit, the same words as flows and agents).

/** How long a revealed value stays up. A person clicks Reveal; there is no Touch ID for now, and an assistant never sees a value. */
export const REVEAL_MS = 60_000;
/** How long after Copy the clipboard is emptied. */
export const CLIPBOARD_MS = 30_000;

/** The groups, in the order the list shows them. */
export const GROUPS = /** @type {const} */ (["Firm keys", "Sending services", "API keys", "Phone", "Logins", "MCP keys", "SSH and notes"]);

/** Sharing levels. "use" lets an agent or flow use the item without seeing it; "edit" also lets the person change it. */
export const LEVELS = /** @type {const} */ ({ use: { label: "Can use", help: "Uses it without seeing the value." }, edit: { label: "Can edit", help: "Can also change or replace it." } });

/** @typedef {{ id: string, sp: string, group: string, name: string, detail: string, secret: string, daysLeft?: number | null, lastUsedDays?: number | null, usedBy: { kind: 'flow'|'agent'|'connection'|'project', name: string }[], shared: { who: string, level: 'use'|'edit' }[] }} VItem */

/** @param {VItem} v @returns {'expiring'|'expired'|'unused'|'ok'} */
export function healthOf(v) {
  if (v.daysLeft != null && v.daysLeft < 0) return "expired";
  if (v.daysLeft != null && v.daysLeft <= 14) return "expiring";
  if (v.lastUsedDays == null || v.lastUsedDays > 90) return "unused";
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
export function visible(items, scope, q = "") {
  const f = q.trim().toLowerCase();
  return items.filter((v) => (scope === "mine" ? v.sp === "mine" : v.sp !== "mine") && (!f || v.name.toLowerCase().includes(f) || v.detail.toLowerCase().includes(f) || v.group.toLowerCase().includes(f)));
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
