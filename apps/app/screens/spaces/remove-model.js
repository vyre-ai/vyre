// @ts-check
// Removing someone from a Space also ends what they hold in the Vault. A member is linked to a Vault person by vault.person.of; when it names one, that person is offboarded with the removal. When it
// does not, the sheet lists the Vault people with the same name and the owner ticks the ones to end: never a silent guess. Pure, so Node tests it.

/** @typedef {{ mode: "linked" | "choose" | "none", linked: string | null, candidates: string[] }} VaultPlan */

const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v.trim() : "");

/** The Vault person vault.person.of names for a member, or null (no link, or the server has no such tool). @param {unknown} d */
export function linkedOf(d) {
  if (typeof d === "string") return str(d) || null;
  const o = /** @type {any} */ (d);
  return (o && (str(o.person) || str(o.name))) || null;
}

/**
 * What the removal does in the Vault. `people` is vault.people's rows (only their names are read). The candidates are the people whose name is the member's name, compared without case; a name that
 * is the linked person's own is not offered twice.
 * @param {{ memberName: string, linked: string | null, people: unknown }} o @returns {VaultPlan}
 */
export function vaultPlan({ memberName, linked, people }) {
  if (linked) return { mode: "linked", linked, candidates: [] };
  const list = Array.isArray(people) ? people : Array.isArray(/** @type {any} */ (people)?.people) ? /** @type {any} */ (people).people : [];
  const want = str(memberName).toLowerCase();
  const names = list.map((p) => str(/** @type {any} */ (p)?.name)).filter(Boolean);
  const candidates = want ? [...new Set(names.filter((n) => n.toLowerCase() === want))] : [];
  return { mode: candidates.length ? "choose" : "none", linked: null, candidates };
}

/** The Vault people to offboard: the linked one, else only the ones ticked among the candidates. @param {VaultPlan} plan @param {string[]} ticked */
export function offboardNames(plan, ticked) {
  if (plan.mode === "linked" && plan.linked) return [plan.linked];
  if (plan.mode === "choose") return plan.candidates.filter((n) => ticked.includes(n));
  return [];
}

/** The words on the sheet. @param {VaultPlan} plan @param {string} name @param {string} space */
export function removeWords(plan, name, space) {
  const title = `Remove ${name} from ${space}?`;
  if (plan.mode === "linked") return { title, body: "Their access to shared Vault items, passes and emergency access ends too." };
  if (plan.mode === "choose") return { title, body: `${name} loses access to ${space}.`, choose: "Also end Vault sharing with:" };
  return { title, body: `${name} had no shared Vault items.` };
}

/** After the removal: one line saying what ended and what to rotate. @param {string} name @param {string} space @param {{ rotate: number }} done */
export function doneLine(name, space, done) {
  const base = `${name} was removed from ${space}.`;
  return done.rotate > 0 ? `${base} ${done.rotate} ${done.rotate === 1 ? "secret" : "secrets"} they could read need a new value: see the Vault.` : base;
}
