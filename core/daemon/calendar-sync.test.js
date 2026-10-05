// @ts-check
// The Space's calendar sync, started by default: it finds a calendar connector in the vault's catalog by its declared ops, pulls the outside calendar into Event records, and pushes Vyre's own
// only through the approval path: a write to the outside calendar is outward, so the kernel asks, a task goes to the owner, nothing is sent until they say yes, and then it goes out once
// with the approval and the bind of exactly that request. The services are a fake Google; the kernel, the gateway, the tasks and the records are real.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { world, ALEX } from "../../kernel/flows/testing/world.js";
import { createCalendarSyncHost } from "./calendar-sync.js";
import { serviceOf } from "../../records/connectors/format.js";
import cal from "../../records/connectors/google-calendar/declaration.js";
import { fakeGoogle, TOKEN } from "../../records/testing/fake-google.js";
import { tempHome } from "../../test/helpers.js";

const SPACE = "spc_harlow000001";

async function rig(t, { ask = false } = {}) {
  const google = fakeGoogle({ mailbox: "alex@harlow.test" });
  const w = await world();
  t.after(() => w.stopListening());
  // a write to an outside service is outward: the kernel asks, unless a standing yes covers it
  if (ask) w.kernel.rules.push({ match: i => i.action === "service.call" && !i.approval, effect: "ask", reason: "outward" });
  else w.kernel.rules.push({ match: i => i.action === "service.call", effect: "allow", reason: "a standing yes" });
  const sent = [];
  const service = async q => {
    const url = new URL(`https://www.googleapis.com${q.request.path}${q.request.query ? "?" + new URLSearchParams(Object.entries(q.request.query).map(([k, v]) => [k, String(v)])) : ""}`);
    if (q.request.method !== "GET") sent.push({ approval: q.approval, bind: q.bind, idem: q.idem, path: q.request.path });
    const out = google.handle({ method: q.request.method, url, headers: { ...(q.request.headers || {}), authorization: `Bearer ${TOKEN}` }, body: q.request.body === undefined ? undefined : JSON.stringify(q.request.body) });
    return { status: out.status, headers: out.headers, body: Buffer.from(out.body).toString("base64") };
  };
  const sync = createCalendarSyncHost({ root: tempHome(t), log: () => {}, connectors: async () => ({ "google-calendar": serviceOf(cal) }), everyMs: 3_600_000, firstMs: 3_600_000 });
  t.after(() => sync.stop());
  const owner = () => w.kernel.chainFor({ flow: "calendar-sync", approver: ALEX, tainted: false, space: SPACE });
  const chains = { forDoer: x => w.kernel.moduleChain({ module: "flows", approver: x.approver }) };
  const h = sync.attach({ space: SPACE, gw: w.kernel, chains, ownerChain: owner, personChain: owner, ownerId: () => ALEX.id, service });
  const events = async () => (await w.kernel.records.query(owner(), "event", { page: { limit: 100 } })).rows;
  const tasks = async () => { await w.kernel.idle(); return w.kernel.tasks.filter(x => /Calendar:/.test(x.title)); };
  return { google, w, h, sent, events, tasks, owner };
}

test("by default it finds the calendar connector, pulls the outside calendar in, and an outside change comes in on the next look", async t => {
  const { google, h, events } = await rig(t);
  google.putEvent({ id: "sign1", summary: "Signing: Rivera trust", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" } });
  const out = await h.runNow();
  assert.equal(out["google-calendar"].pulled.created, 1);
  assert.equal((await events())[0].data.title, "Signing: Rivera trust");
  google.putEvent({ ...google.events.get("sign1"), summary: "Signing: Rivera trust (moved)", updated: undefined });
  await h.runNow();
  assert.equal((await events())[0].data.title, "Signing: Rivera trust (moved)");
});

test("with a standing yes a Vyre event goes out at once, tied to its outside id", async t => {
  const { google, w, h, sent, events, owner } = await rig(t);
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", source: "vyre" });
  const out = await h.runNow();
  assert.equal(out["google-calendar"].pushed.inserted, 1, JSON.stringify(out));
  assert.equal(google.events.size, 1); assert.equal(sent.length, 1);
  assert.match((await events())[0].data.external_id, /^[0-9a-f]{32}$/);
});

test("a write to the outside calendar is held for the owner's yes: a task, nothing sent, and once approved it goes out once with the approval", async t => {
  const { google, w, h, sent, events, tasks, owner } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  let out = await h.runNow();
  assert.equal(out["google-calendar"].pushed.held, 1, JSON.stringify(out));
  assert.equal(sent.length, 0, "nothing was sent"); assert.equal(google.events.size, 0);
  let ts = await tasks();
  assert.equal(ts.length, 1, "a task is in front of the owner");
  assert.equal(ts[0].checker.id, ALEX.id); assert.equal(ts[0].form.action, "service.call"); assert.match(ts[0].title, /Closing call/);
  out = await h.runNow();
  assert.equal(out["google-calendar"].pushed.held, 1, "still waiting");
  assert.equal((await tasks()).length, 1, "and no second task");
  w.kernel.completeTask(ts[0].id, { outcome: "approved" });
  await w.kernel.idle();
  out = await h.runNow();
  assert.equal(out["google-calendar"].pushed.inserted, 1, JSON.stringify(out));
  assert.equal(sent.length, 1); assert.equal(sent[0].approval, ts[0].id); assert.match(sent[0].bind, /./);
  assert.equal(google.events.size, 1);
  assert.equal((await events())[0].data.calendar, "google-calendar");
  out = await h.runNow();
  assert.deepEqual(out["google-calendar"].pushed, { inserted: 0, patched: 0, held: 0, refused: 0, conflicts: 0 }, "done: nothing more goes out");
  assert.equal(sent.length, 1);
});

test("a no from the owner is final for that change: nothing is sent and no new task is made", async t => {
  const { google, w, h, sent, tasks, owner } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Dentist", starts_at: "2026-10-07T17:00:00.000Z", source: "vyre" });
  await h.runNow();
  const [task] = await tasks();
  w.kernel.completeTask(task.id, { outcome: "rejected" });
  await w.kernel.idle();
  const out = await h.runNow();
  assert.equal(out["google-calendar"].pushed.refused, 1, JSON.stringify(out));
  await h.runNow();
  assert.equal(sent.length, 0); assert.equal(google.events.size, 0); assert.equal((await tasks()).length, 1);
});

test("a rule of the Space that refuses is a refusal: nothing is sent and nobody is asked", async t => {
  const { google, w, h, sent, tasks, owner } = await rig(t);
  w.kernel.rules.unshift({ match: i => i.action === "service.call", effect: "deny", reason: "rule_never", rule: { label: "Assistants never write to calendars" } });
  await w.kernel.records.create(owner(), "event", { title: "Dentist", starts_at: "2026-10-07T17:00:00.000Z", source: "vyre" });
  const out = await h.runNow();
  assert.equal(out["google-calendar"].pushed.refused, 1, JSON.stringify(out));
  assert.equal(sent.length, 0); assert.equal(google.events.size, 0); assert.equal((await tasks()).length, 0);
});

test("with no calendar connector in the vault it does nothing", async t => {
  const w = await world();
  t.after(() => w.stopListening());
  const sync = createCalendarSyncHost({ root: tempHome(t), log: () => {}, connectors: async () => ({ stripe: { ops: [{ name: "customers.get" }] } }), everyMs: 3_600_000, firstMs: 3_600_000 });
  t.after(() => sync.stop());
  const h = sync.attach({ space: SPACE, gw: w.kernel, chains: {}, ownerChain: () => w.kernel.sysChain(), personChain: () => w.kernel.sysChain(), ownerId: () => ALEX.id, service: async () => { throw new Error("must not be called"); } });
  assert.deepEqual(await h.runNow(), {});
});
