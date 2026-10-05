// @ts-check
// "Set up My Cloud" and "Move to My Cloud" in words (windows' spaces.create with a server home, spaces.upgrade.plan and spaces.upgrade.run). Pure: the screen passes in what the box answered.
// My Cloud is an ordinary space on the person's own paired server; moving carries the Personal space's records, chats and memory there as they are, with one approval bound to the plan the person was shown.

export const SET_UP = { title: "Set up My Cloud", body: "A space on your own server, for your reminders, notes, records and flows. Nothing moves until you ask.", action: "Set up My Cloud" };
export const MOVE = { title: "Move to My Cloud", body: "Carry what is in Personal over to My Cloud. You see what moves first, and approve once.", action: "See what would move", approve: "Move it", blocked: "This cannot start yet" };

/** The input of spaces.create for My Cloud on a paired server. @param {{ id: string, name: string }} server @param {string} [slug] the address's first part */
export const setupInput = (server, slug = "my-cloud") => ({ name: slug, displayName: "My Cloud", home: { kind: "server", device: { id: server.id, name: server.name, alwaysOn: true }, confirmed: true } });

/** The input of spaces.upgrade.run: My Cloud's space id and the hash of the plan that was shown. @param {{ hash: string }} plan @param {string} to */
export const runInput = (plan, to) => ({ to, plan_hash: plan.hash });

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** A record type's name as a person reads it: "planner_alarm" is "planner alarm". @param {string} t */
const typeWords = (t) => t.replace(/_/g, " ");

/**
 * What would move, line by line, from spaces.upgrade.plan's answer: records by type, chats, memory, fields My Cloud's types gain, types that stay, and sealed fields. Nothing is invented: a part the plan does not have has no line.
 * @param {any} plan @returns {string[]}
 */
export function planLines(plan) {
  /** @type {string[]} */ const out = [];
  const rec = plan?.counts?.records && typeof plan.counts.records === "object" ? Object.entries(plan.counts.records) : [];
  for (const [type, n] of rec) if (typeof n === "number" && n > 0) out.push(count(n, typeWords(type), `${typeWords(type)}s`.replace(/ss$/, "s")));
  if (plan?.counts?.chats) out.push("Your chats, with their history");
  if (plan?.counts?.memory) out.push("What your assistant remembers about you, still encrypted");
  if (Array.isArray(plan?.sealed) && plan.sealed.length) out.push(`${count(plan.sealed.length, "private field", "private fields")}, moved still sealed`);
  for (const e of Array.isArray(plan?.extend) ? plan.extend : []) if (e && typeof e.type === "string" && Array.isArray(e.fields) && e.fields.length) out.push(`${typeWords(e.type)} gains ${e.fields.join(", ")} in My Cloud`);
  for (const s of Array.isArray(plan?.skippedTypes) ? plan.skippedTypes : []) if (s && typeof s.type === "string") out.push(`${typeWords(s.type)} stays in Personal${s.why ? `: ${s.why}` : ""}`);
  return out;
}

/** Nothing to move says so. @param {any} plan */
export const planEmpty = (plan) => planLines(plan).length === 0;
/** What stops the move, in the box's own words; empty when it can start. @param {any} plan @returns {string[]} */
export const blockersOf = (plan) => (Array.isArray(plan?.blockers) ? plan.blockers.filter((/** @type {unknown} */ b) => typeof b === "string" && b) : []);
/** The Move button shows only when nothing blocks it and there is something to carry. @param {any} plan */
export const canMove = (plan) => typeof plan?.hash === "string" && plan.hash !== "" && blockersOf(plan).length === 0;

/**
 * The report after the move, from spaces.upgrade.run's answer: what moved, what did not (by name), and whether Personal now points to My Cloud.
 * @param {any} r @returns {{ moved: string[], notMoved: string[], after: string, notes: string[] }}
 */
export function reportLines(r) {
  const moved = planLines({ counts: r?.moved ? { records: r.moved.records, chats: r.moved.chats, memory: r.moved.memory } : {} });
  const notMoved = (Array.isArray(r?.notMoved) ? r.notMoved : []).filter((/** @type {any} */ n) => n && typeof n.what === "string").map((/** @type {any} */ n) => `${n.what}: ${n.why || "it did not move"}`);
  const notes = (Array.isArray(r?.notes) ? r.notes : []).filter((/** @type {any} */ n) => n && typeof n.what === "string").map((/** @type {any} */ n) => `${n.what}: ${n.why || ""}`.trim());
  const after = r?.frozen ? "Personal now points to My Cloud and is read-only. Nothing was deleted."
    : notMoved.length ? "Personal is unchanged. Try again once the items above are sorted out."
    : r?.not_frozen_because ? `Personal is unchanged: ${r.not_frozen_because}` : "Personal is unchanged.";
  return { moved, notMoved, after, notes };
}

/** The words for a move the box refused. @param {any} e */
export function refusalLine(e) {
  const code = String(e?.code ?? "");
  if (code === "plan_changed") return "Your Personal space changed since you were shown the plan. Look at it again.";
  if (code === "blocked") return String(e?.message ?? "This cannot start yet.");
  return typeof e?.message === "string" && e.message ? e.message : "The move did not finish. Nothing was deleted.";
}

/**
 * Which rows of spaces.list matter: the Personal space (tier basic), whether My Cloud exists (a personal space on the person's own server: tier cloud, who personal), and where Personal was moved to.
 * @param {readonly any[]} list @returns {{ personal: any | null, cloud: any | null, movedTo: string | null }}
 */
export function cloudState(list) {
  const rows = Array.isArray(list) ? list : [];
  const personal = rows.find((r) => r && r.tier === "basic") ?? null;
  const cloud = rows.find((r) => r && r.tier === "cloud" && (r.who === "personal" || r.setup?.who === "personal" || r.setup?.picks?.who === "personal" || r.displayName === "My Cloud")) ?? null;
  return { personal, cloud, movedTo: typeof personal?.upgraded_to === "string" && personal.upgraded_to ? personal.upgraded_to : null };
}

/** What the card offers: set up (none yet), move (it exists and Personal has not moved), or done. @param {ReturnType<typeof cloudState>} s @param {boolean} hasServer a paired server exists to make it on @returns {"setup" | "move" | "moved" | "none"} */
export function offerFor(s, hasServer) {
  if (!s.personal) return "none";
  if (s.movedTo) return "moved";
  if (s.cloud) return "move";
  return hasServer ? "setup" : "none";
}

/** The person's paired servers from relay.devices.list ({ devices: [{ id, name, kind }] }): the ones My Cloud can be made on. @param {any} data @returns {{ id: string, name: string }[]} */
export const serversOf = (data) => (Array.isArray(data?.devices) ? data.devices : []).filter((/** @type {any} */ d) => d && d.kind === "server" && typeof d.id === "string" && typeof d.name === "string").map((/** @type {any} */ d) => ({ id: d.id, name: d.name }));
