// @ts-check
// kernel/flows/run-record: the record a run is about (team/contracts/flow-runs.md). Pure. A run answers "what was this for" with one urn, taken from the trigger, so the record's
// timeline, the Now list and an agent all find a record's runs the same way (records.linked on flow-run.record) and nothing keeps a second list.

const RECORD_URN = /^vyre:\/\/[^/\s]+\/([a-z0-9][a-z0-9-]*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Subjects that name a thing the log made up, not a record of the business. */
const NOT_RECORDS = new Set(["event", "flow", "flow-run", "definition", "approval"]);

/** @param {any} v @returns {string | null} a record urn, or null */
function asRecordUrn(v) {
  const u = v && typeof v === "object" && typeof v.urn === "string" ? v.urn : v;
  const m = typeof u === "string" ? RECORD_URN.exec(u) : null;
  return m && !NOT_RECORDS.has(m[1]) ? u : null;
}

/**
 * The record a run is about: what the trigger names, in this order: the data's `record` (a task or a step says which record it is for), the event's subject when it is a record (a stage
 * entry, a record change), the input's `record` or `urn` (a manual start). Null when the trigger names none (a schedule, a web call with no record).
 * @param {{ event?: any, input?: any }} trig @returns {string | null}
 */
export function recordOfTrigger(trig) {
  const ev = trig && trig.event;
  if (ev) return asRecordUrn(ev.data && ev.data.record) || asRecordUrn(ev.subject);
  const inp = trig && trig.input;
  return inp && typeof inp === "object" ? asRecordUrn(inp.record) || asRecordUrn(inp.urn) : null;
}
