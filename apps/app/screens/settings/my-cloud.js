// @ts-check
// "Set up My Cloud" and "Move to My Cloud" in words (windows' spaces.create with a server home, spaces.upgrade.plan and spaces.upgrade.run). Pure: the screen passes in what the box answered.
// My Cloud is an ordinary space on the person's own paired server; moving carries the Personal space's records, chats and memory there as they are, with one approval bound to the plan the person was shown.

export const SET_UP = { title: "Set up My Cloud", body: "A space on your own server, for your reminders, notes, records and flows. Nothing moves until you ask.", action: "Set up My Cloud" };
export const MOVE = { title: "Move to My Cloud", body: "Carry what is in Personal over to My Cloud. You see what moves first, and approve once.", action: "See what would move", approve: "Move it", blocked: "This cannot start yet" };

/** The input of spaces.create for My Cloud on a paired server. @param {{ id: string, name: string }} server @param {string} [slug] the address's first part */
export const setupInput = (server, slug = "my-cloud") => ({ name: slug, displayName: "My Cloud", home: { kind: "server", device: { id: server.id, name: server.name, alwaysOn: true }, confirmed: true } });

/** The input of spaces.upgrade.run: My Cloud's space id and the hash of the plan that was shown. @param {{ hash: string }} plan @param {string} to */
export const runInput = (plan, to) => ({ to, plan_hash: plan.hash });

/**
 * What spaces.upgrade.run asks the person's key to sign, from its `{ needs_proof: true, request?, approve_request? }` answer: the move itself (`request`, sent again as the call's kernel proof) and, when the plan has private
 * fields, the exact list of them (`approve_request`, sent again as `approve_proof`). Both are signed together, in one prompt. @param {any} r @returns {{ move: any | null, approve: any | null }}
 */
export function proofsAsked(r) {
  const ok = (/** @type {any} */ q) => (q && typeof q === "object" && typeof q.op === "string" && typeof q.space === "string" && typeof q.payload_hash === "string" ? q : null);
  return { move: ok(r?.request), approve: ok(r?.approve_request) };
}

/** The input of the second call: the plan's hash again, with the list's proof when one was signed. @param {{ hash: string }} plan @param {string} to @param {any} approveProof */
export const runInputWith = (plan, to, approveProof) => ({ ...runInput(plan, to), ...(approveProof ? { approve_proof: approveProof } : {}) });

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The plural of a record type's name: a consonant then y is "ies", s, x, ch and sh take "es", the rest "s". @param {string} w */
export const plural = (w) => (/[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`);
/** A record type's name as a person reads it: "planner_alarm" is "planner alarm". @param {string} t */
const typeWords = (t) => t.replace(/_/g, " ");

/**
 * What would move, line by line, from spaces.upgrade.plan's answer: records by type, chats, memory, fields My Cloud's types gain, types that stay, and sealed fields. Nothing is invented: a part the plan does not have has no line.
 * @param {any} plan @returns {string[]}
 */
export function planLines(plan) {
  /** @type {string[]} */ const out = [];
  const rec = plan?.counts?.records && typeof plan.counts.records === "object" ? Object.entries(plan.counts.records) : [];
  for (const [type, n] of rec) if (typeof n === "number" && n > 0) out.push(count(n, typeWords(type), plural(typeWords(type))));
  if (plan?.counts?.chats) out.push("Your chats, with their history");
  if (plan?.counts?.memory) out.push("What your assistant remembers about you, still encrypted");
  if (Array.isArray(plan?.sealed) && plan.sealed.length) out.push(`${count(plan.sealed.length, "private field", "private fields")}, moved still sealed`);
  for (const e of Array.isArray(plan?.extend) ? plan.extend : []) if (e && typeof e.type === "string" && Array.isArray(e.fields) && e.fields.length) out.push(`${typeWords(e.type)} gains ${e.fields.map(typeWords).join(", ")} in My Cloud`);
  for (const s of Array.isArray(plan?.skippedTypes) ? plan.skippedTypes : []) if (s && typeof s.type === "string") out.push(`${typeWords(s.type)} stays in Personal${s.why ? `: ${s.why}` : ""}`);
  return out;
}

/**
 * Where the data goes, named for the one approval: the plan's own `target_name` (it is inside the plan hash the person approves, so what is shown is what is bound), as an address ("acme" is acme.vyre.run). null when the
 * plan names none: nothing is made up. @param {any} plan @returns {string | null}
 */
export function targetOf(plan) {
  const n = typeof plan?.target_name === "string" ? plan.target_name.trim().toLowerCase() : "";
  if (!n || !/^[a-z0-9][a-z0-9.-]{0,80}$/.test(n)) return null;
  return n.includes(".") ? n : `${n}.vyre.run`;
}

/** The line over the approval and the words the signature prompt shows. @param {any} plan */
export const approvalLine = (plan) => { const t = targetOf(plan); return t ? `${MOVE.title}: ${t}` : MOVE.title; };

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

/** What the card offers: add a server (Personal has none yet and no server is paired), set up (a server is paired), move (it exists and Personal has not moved), or done. @param {ReturnType<typeof cloudState>} s @param {boolean} hasServer a paired server exists to make it on @returns {"add" | "setup" | "move" | "moved" | "none"} */
export function offerFor(s, hasServer) {
  if (!s.personal) return "none";
  if (s.movedTo) return "moved";
  if (s.cloud) return "move";
  return hasServer ? "setup" : "add";
}

/** The person's paired servers from spaces.servers ({ servers: [{ id, name, online }] }): the ones My Cloud can be made on. An empty list means none is paired, and the card stays away. @param {any} data @returns {{ id: string, name: string }[]} */
export const serversOf = (data) => (Array.isArray(data?.servers) ? data.servers : []).filter((/** @type {any} */ d) => d && typeof d.id === "string" && d.id && typeof d.name === "string").map((/** @type {any} */ d) => ({ id: d.id, name: d.name }));
