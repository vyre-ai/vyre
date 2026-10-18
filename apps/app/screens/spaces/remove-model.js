// @ts-check
// Removing someone from a Space also ends what they hold in the Vault. A member is linked to a Vault person by vault.person.of; when it names one, that person is offboarded with the removal. When it
// does not, the sheet lists the Vault people with the same name and the owner ticks the ones to end: never a silent guess. Pure, so Node tests it.

/** @typedef {{ mode: "linked" | "choose" | "none" | "unchecked", linked: string | null, verified: boolean, candidates: string[] }} VaultPlan */

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v.trim() : "");

/** The Vault person vault.person.of names for a member, and whether their safety words were checked ({ name, verified }), or null (no link, or the server has no such tool). A server that does not say counts as checked. @param {unknown} d @returns {{ name: string, verified: boolean } | null} */
export function linkedOf(d) {
  if (typeof d === "string") return str(d) ? { name: str(d), verified: true } : null;
  const o = /** @type {any} */ (d);
  const name = o && (str(o.person) || str(o.name));
  return name ? { name, verified: o.verified !== false } : null;
}

/**
 * What the removal does in the Vault. `people` is vault.people's rows (only their names are read). The candidates are the people whose name is the member's name, compared without case; a name that
 * is the linked person's own is not offered twice.
 * @param {{ memberName: string, linked: { name: string, verified: boolean } | null, people: unknown }} o @returns {VaultPlan}
 */
export function vaultPlan({ memberName, linked, people }) {
  if (linked) return { mode: "linked", linked: linked.name, verified: linked.verified, candidates: [] };
  // No answer from vault.people at all (the tool is missing, locked, or failed): the Vault was not checked, which is not the same as nothing being there.
  if (people === null || people === undefined) return { mode: "unchecked", linked: null, verified: true, candidates: [] };
  const list = Array.isArray(people) ? people : Array.isArray(/** @type {any} */ (people)?.people) ? /** @type {any} */ (people).people : [];
  const want = str(memberName).toLowerCase();
  const names = list.map((p) => str(/** @type {any} */ (p)?.name)).filter(Boolean);
  const candidates = want ? [...new Set(names.filter((n) => n.toLowerCase() === want))] : [];
  return { mode: candidates.length ? "choose" : "none", linked: null, verified: true, candidates };
}

/** The Vault people to offboard: the linked one, else only the ones ticked among the candidates. @param {VaultPlan} plan @param {string[]} ticked */
export function offboardNames(plan, ticked) {
  // A linked person is ended with the removal; if their safety words were never checked the owner sees the row ticked and can untick it, so it is never done silently.
  if (plan.mode === "linked" && plan.linked) return plan.verified || ticked.includes(plan.linked) ? [plan.linked] : [];
  if (plan.mode === "choose") return plan.candidates.filter((n) => ticked.includes(n));
  return [];
}

/** The words on the sheet. @param {VaultPlan} plan @param {string} name @param {string} space */
export function removeWords(plan, name, space) {
  const title = `Remove ${name} from ${space}?`;
  if (plan.mode === "linked" && !plan.verified) return { title, body: `${name} loses access to ${space}.`, choose: "Also end their Vault sharing:" };
  if (plan.mode === "linked") return { title, body: "Their access to shared Vault items, passes and emergency access ends too." };
  if (plan.mode === "choose") return { title, body: `${name} loses access to ${space}.`, choose: "Also end Vault sharing with:" };
  if (plan.mode === "unchecked") return { title, body: `The Vault could not be checked. If you shared Vault items with ${name}, end them in the Vault.` };
  return { title, body: `No one in the Vault is linked to ${name} or shares their name. If you shared items under another name, end them in the Vault.` };
}

/** After the removal: one line saying what ended, what could not be ended, and what to rotate. @param {string} name @param {string} space @param {{ rotate: number, failed?: string[] }} done */
export function doneLine(name, space, done) {
  const base = `${name} was removed from ${space}.`;
  const failed = done.failed && done.failed.length ? ` Vault access for ${done.failed.join(", ")} was not ended. End it from the Vault.` : "";
  const rotate = done.rotate > 0 ? ` ${done.rotate} ${done.rotate === 1 ? "secret" : "secrets"} they could read need a new value: see the Vault.` : "";
  return `${base}${failed}${rotate}`;
}

/** The rows the sheet lets the owner tick: the same-named people, or the linked person whose safety words were not checked (ticked to begin with). @param {VaultPlan} plan @returns {{ name: string, label: string, ticked: boolean }[]} */
export function tickRows(plan) {
  if (plan.mode === "linked" && !plan.verified && plan.linked) return [{ name: plan.linked, label: `${plan.linked} (safety words not checked)`, ticked: true }];
  if (plan.mode === "choose") return plan.candidates.map((n) => ({ name: n, label: n, ticked: false }));
  return [];
}
