// @ts-check
// Who sees a synced event. (A note is the planner's Note type and is shared with planner.update { item, visibility, record }; see core/planner/note-share.js.) An event that came from an outside calendar starts private to the
// person whose calendar it is, and the others see a Busy block. The kernel decides every read (kernel/gateway/private-rows.js: the `note` and `event` rules, which bind an owner and an admin too);
// these tools change the setting and answer the Busy blocks.
// records.share { urn, visibility } changes it (the writer only). records.busy { from, to } lists the blocks of time that other people's private events take up, with nothing else of them.

export const SHARE_LEVELS = ["private", "record", "space"];
const SHAREABLE = new Set(["event"]);
const DAY = 86_400_000;

/** The level a type allows: an event has no "record" level (it belongs to a calendar, not a record). @param {string} type @param {string} level */
export function levelProblem(type, level) {
  if (!SHARE_LEVELS.includes(level)) return `Pick one of: ${SHARE_LEVELS.join(", ")}. ${level} is not one of them.`;
  if (type === "event" && level === "record") return "An event is shared with the Space or kept private. Pick private or space.";
  return "";
}

/** A Busy block: the time and nothing else. @param {any} row */
export function busyBlock(row) {
  const d = row.data || {};
  return { starts_at: d.starts_at, ends_at: d.ends_at || null, all_day: d.all_day === true, busy: true };
}

/** Whether an event is one the caller cannot see in full: it came from an outside calendar and was not shared with the Space. @param {any} row */
export const isPrivateSynced = (row) => Boolean(row && row.data && row.data.source === "google" && row.data.visibility !== "space");

/** The window of a busy call as two ISO times: from now (or `from`) for at most 62 days. @param {any} i @param {number} [now] */
export function windowOf(i, now = Date.now()) {
  const from = i && i.from ? Date.parse(String(i.from)) : now;
  const to = i && i.to ? Date.parse(String(i.to)) : from + 14 * DAY;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("Give from and to as dates, like 2026-10-19.");
  if (to <= from) throw new Error("to must be after from.");
  if (to - from > 62 * DAY) throw new Error("Ask for at most 62 days at a time.");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerVisibility({ tool, obj, str, refuse, parseUrn }) {
  const byUrn = (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space });
  tool("records.share", "Change who can read an event from an outside calendar: { urn, visibility: private|space }. private is its owner only; space is every member. Only its owner changes it. A note is shared with planner.update.",
    obj({ space: str, urn: str, visibility: str }, ["urn", "visibility"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      if (!SHAREABLE.has(u.type)) throw refuse("Only an event from an outside calendar is shared this way. A note is shared with planner.update.", "bad_input");
      const bad = levelProblem(u.type, String(i.visibility));
      if (bad) throw refuse(bad, "bad_input");
      const row = await d.gateway.records.get(d.chain, u.type, u.id);
      if (!row) throw refuse("That is not here, or it is not yours to see.", "not_found");
      const at = (typeof d.gateway.records.attrsOf === "function" ? d.gateway.records.attrsOf(String(i.urn)) : null) || {};
      const me = d.chain.hops.find((/** @type {any} */ h) => h.actor.kind === "person");
      const mine = me && [String(at.owner || ""), String(at.created_for || "")].some((x) => x === me.actor.id || x === `person:${me.actor.id}`);
      if (!mine) throw refuse("Only the person who wrote it changes who can read it.", "not_allowed");
      const out = await d.gateway.records.update(d.chain, u.type, u.id, { visibility: i.visibility }, row.version);
      return { record: out };
    }, byUrn);

  tool("records.busy", "Blocks of time other people's private calendar events take up, as Busy only: { from?, to? }, default 14 days.",
    obj({ space: str, from: str, to: str }), async (/** @type {any} */ i, /** @type {any} */ d) => {
      let w; try { w = windowOf(i); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      const spec = { filter: { and: [{ field: "starts_at", op: "gte", value: w.from }, { field: "starts_at", op: "lt", value: w.to }] }, page: { limit: 200 } };
      // what the caller may read in full is theirs to list; the rest of the synced events are read as the Space and cut to their time
      const mine = new Set(((await d.gateway.records.query(d.chain, "event", spec)).rows || []).map((/** @type {any} */ r) => r.id));
      const all = (await d.gateway.records.query(d.gateway.serviceChain("records"), "event", spec)).rows || [];
      return { busy: all.filter((/** @type {any} */ r) => !mine.has(r.id) && isPrivateSynced(r)).map(busyBlock) };
    });
}
