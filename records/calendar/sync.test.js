import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createRecordsHost } from "../host.js";
import { CORE_TYPES } from "../core-types.js";
import { createCalendarSync } from "./sync.js";
import { fromGoogle, toGoogle } from "./google.js";
import { callThrough } from "./declared-call.js";
import calendarDeclaration from "../connectors/google-calendar/declaration.js";

const SPACE = "spc_harlow000001";
/** A tiny Google Calendar: events by id, an etag that changes on every write, sync tokens, and If-Match. */
function fakeGoogle() {
  const g = { events: new Map(), rev: 0, calls: [], expireToken: false };
  const stamp = (e) => ({ ...e, etag: `"e${++g.rev}"`, updated: g.rev });
  g.put = (e) => { g.events.set(e.id, stamp(e)); };
  g.request = async ({ method, url, body, headers }) => {
    g.calls.push(`${method} ${url.replace("https://www.googleapis.com/calendar/v3/calendars/primary", "")}${headers?.["if-match"] ? " if-match" : ""}`);
    const u = new URL(url);
    if (method === "GET" && /\/events\/[^/?]+$/.test(u.pathname)) { const e = g.events.get(decodeURIComponent(u.pathname.split("/").pop())); return e ? { status: 200, body: e } : { status: 404, body: {} }; }
    if (method === "GET") {
      const tok = u.searchParams.get("syncToken");
      if (tok && g.expireToken) { g.expireToken = false; return { status: 410, body: {} }; }
      const since = tok ? Number(tok.replace("t", "")) : 0;
      return { status: 200, body: { items: [...g.events.values()].filter((e) => e.updated > since && (tok || e.status !== "cancelled")), nextSyncToken: `t${g.rev}` } };
    }
    if (method === "POST") { const id = body.id ?? `g${g.events.size + 1}`; if (g.events.has(id)) return { status: 409, body: {} }; const e = stamp({ ...body, id }); g.events.set(id, e); return { status: 200, body: e }; }
    if (method === "PATCH") {
      const id = decodeURIComponent(u.pathname.split("/").pop()); const cur = g.events.get(id);
      if (headers?.["if-match"] && headers["if-match"] !== cur.etag) return { status: 412, body: {} };
      const e = stamp({ ...cur, ...body }); g.events.set(id, e); return { status: 200, body: e };
    }
    return { status: 400, body: {} };
  };
  return g;
}
const timed = (id, summary, hour, extra = {}) => ({ id, summary, status: "confirmed", start: { dateTime: `2026-10-06T${hour}:00:00-07:00`, timeZone: "America/Los_Angeles" }, end: { dateTime: `2026-10-06T${Number(hour) + 1}:00:00-07:00`, timeZone: "America/Los_Angeles" }, ...extra });

async function rig(over = {}) {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  const google = fakeGoogle();
  const reports = [];
  // the sync speaks the declaration's ops; the fake Google is the transport
  const call = callThrough(calendarDeclaration, ({ method, path, query, body, headers }) => google.request({ method, url: `https://www.googleapis.com${path}${query ? "?" + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])) : ""}`, body, headers }));
  const asked = [];
  // the approval path: `write` runs the act when it is allowed or approved, and answers held or refused otherwise
  const write = over.policy === undefined ? undefined : async (c, perform) => {
    const verdict = await over.policy(c);
    if (verdict === "allow") return { done: true, value: await perform() };
    if (verdict === "hold") { asked.push(c.title); return over.hold && (await over.hold(c)) ? { done: true, value: await perform({ approval: "tsk_ok" }) } : { done: false, held: true }; }
    return { done: false, refused: true };
  };
  const { policy: _p, hold: _h, ...rest } = over;
  const sync = createCalendarSync({ kernel: host.kernel, chain: () => host.ownerChain(), call, ...(write ? { write } : {}), report: (t, d) => reports.push([t, d]), ...rest });
  const events = async () => (await host.kernel.records.query(host.ownerChain(), "event", { page: { limit: 100 } })).rows;
  return { host, google, sync, events, reports };
}

test("the Event type is a core type with the fields the calendar needs", () => {
  const e = CORE_TYPES.find((t) => t.name === "event");
  assert.deepEqual(e.fields.map((f) => f.name), ["title", "starts_at", "ends_at", "all_day", "time_zone", "place", "people", "record", "source", "calendar", "external_id", "notes"]);
});

test("google shapes: timed, all-day, attendees, and back", () => {
  const d = fromGoogle({ id: "a", summary: "Signing", location: "Harlow Legal", attendees: [{ email: "Sam@Example.test" }], ...timed("a", "Signing", "09") }, "google-calendar");
  assert.equal(d.starts_at, "2026-10-06T16:00:00.000Z"); assert.deepEqual(d.people, ["sam@example.test"]); assert.equal(d.time_zone, "America/Los_Angeles");
  const day = fromGoogle({ id: "b", summary: "Deadline", start: { date: "2026-10-09" }, end: { date: "2026-10-10" } }, "x");
  assert.equal(day.all_day, true); assert.equal(toGoogle(day).start.date, "2026-10-09");
  assert.equal(fromGoogle({ id: "c" }, "x"), null);
});

test("pull makes records, then an incremental pull updates and removes", async () => {
  const { google, sync, events } = await rig();
  google.put(timed("g1", "Intake call", "09")); google.put(timed("g2", "Signing", "13"));
  assert.deepEqual(await sync.pull(), { created: 2, updated: 0, removed: 0 });
  assert.equal((await events()).length, 2);
  google.put({ ...timed("g1", "Intake call (moved)", "10") }); google.put({ id: "g2", status: "cancelled" });
  assert.deepEqual(await sync.pull(), { created: 0, updated: 1, removed: 1 });
  const rows = await events();
  assert.equal(rows.length, 1); assert.equal(rows[0].data.title, "Intake call (moved)");
  assert.ok(google.calls.at(-1).includes("syncToken=t"), "the second pull was incremental");
  assert.deepEqual(await sync.pull(), { created: 0, updated: 0, removed: 0 }, "nothing new, nothing done");
});

test("an expired sync token starts over without losing or doubling events", async () => {
  const { google, sync, events } = await rig();
  google.put(timed("g1", "A", "09")); await sync.pull();
  google.expireToken = true; google.put(timed("g3", "C", "11"));
  await sync.pull();
  assert.equal((await events()).length, 2);
});

test("nothing is written outward without a policy that allows it; refused and held changes are reported, not sent", async () => {
  const { host, google, sync, reports } = await rig();
  await host.kernel.records.create(host.ownerChain(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", source: "vyre" });
  assert.deepEqual(await sync.push(), { inserted: 0, patched: 0, held: 0, refused: 1, conflicts: 0 });
  assert.equal(google.calls.length, 0);
  assert.equal(reports[0][0], "calendar.refused");
  const held = await rig({ policy: () => "hold", hold: async () => false });
  await held.host.kernel.records.create(held.host.ownerChain(), "event", { title: "x", starts_at: "2026-10-07T17:00:00.000Z", source: "vyre" });
  assert.equal((await held.sync.push()).held, 1);
  assert.equal((await held.sync.push()).held, 1, "a held change is asked again on the next push, not lost");
  assert.equal(held.google.calls.length, 0, "a hold nobody approved sends nothing");
});

test("an allowed new event is inserted, tied to its outside id, and its own write is not echoed back", async () => {
  const { host, google, sync, events } = await rig({ policy: () => "allow" });
  await host.kernel.records.create(host.ownerChain(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", people: ["sam@example.test"], source: "vyre" });
  assert.equal((await sync.push()).inserted, 1);
  const [e] = await events();
  assert.match(e.data.external_id, /^[0-9a-f]{32}$/, "the event id is ours, derived from the record"); assert.equal(e.data.calendar, "google-calendar");
  assert.equal(google.events.get(e.data.external_id).attendees[0].email, "sam@example.test");
  assert.deepEqual(await sync.push(), { inserted: 0, patched: 0, held: 0, refused: 0, conflicts: 0 }, "no change, no call");
  assert.deepEqual(await sync.pull(), { created: 0, updated: 0, removed: 0 }, "the pull does not duplicate it");
  assert.equal((await events()).length, 1);
});

test("a held change goes out once it is approved", async () => {
  const asked = [];
  const { host, google, sync } = await rig({ policy: () => "hold", hold: async (c) => { asked.push(c.title); return true; } });
  await host.kernel.records.create(host.ownerChain(), "event", { title: "Court date", starts_at: "2026-10-12T16:00:00.000Z", source: "vyre" });
  assert.equal((await sync.push()).inserted, 1);
  assert.deepEqual(asked, ["Court date"]); assert.equal(google.events.size, 1);
});

test("a local edit is patched with the etag, and is not overwritten by a pull that has the old copy", async () => {
  const { host, google, sync, events } = await rig({ policy: () => "allow" });
  google.put(timed("g1", "Intake call", "09")); await sync.pull();
  const [e] = await events();
  await host.kernel.records.update(host.ownerChain(), "event", e.id, { place: "Room 2" }, e.version);
  assert.deepEqual(await sync.pull(), { created: 0, updated: 0, removed: 0 }, "the local edit wins over the old copy");
  assert.equal((await events())[0].data.place, "Room 2");
  assert.equal((await sync.push()).patched, 1);
  assert.ok(google.calls.at(-1).includes("if-match"));
  assert.equal(google.events.get("g1").location, "Room 2");
});

test("both sides edited: the outside copy wins and the conflict is reported", async () => {
  const { host, google, sync, events, reports } = await rig({ policy: () => "allow" });
  google.put(timed("g1", "Intake call", "09")); await sync.pull();
  const [e] = await events();
  await host.kernel.records.update(host.ownerChain(), "event", e.id, { place: "Room 2" }, e.version);
  google.put({ ...timed("g1", "Intake call", "09"), location: "Zoom" });
  assert.equal((await sync.push()).conflicts, 1);
  assert.equal(reports.at(-1)[0], "calendar.conflict");
  await sync.pull();
  assert.equal((await events())[0].data.place, "Zoom");
});

test("every write went through the gateway: the log has the events and verifies", async () => {
  const { host, google, sync } = await rig();
  google.put(timed("g1", "A", "09")); await sync.pull();
  assert.equal(host.log.read({ type: "event.created" }).length, 1);
  assert.equal(host.log.verify().ok, true);
});

test("a repeat of an insert after a crash (the outside event exists, the record never learned its id) reads that event and does not make a second", async () => {
  const { host, google, sync, events } = await rig({ policy: () => "allow" });
  const r = await host.kernel.records.create(host.ownerChain(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", source: "vyre" });
  const id = String(r.id).replace(/-/g, "").toLowerCase();
  google.put({ id, summary: "Closing call", start: { dateTime: "2026-10-07T17:00:00Z" }, end: { dateTime: "2026-10-07T17:00:00Z" } });
  assert.equal((await sync.push()).inserted, 1);
  assert.equal(google.events.size, 1, "one event outside");
  assert.equal((await events())[0].data.external_id, id);
});
