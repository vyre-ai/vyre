// @ts-check
// The Space's calendar sync, started by default: for each Google account connected to the google module it pulls the outside calendar into Event records, and pushes Vyre's own only through
// the approval path: a write that invites people is outward, so the kernel asks, a task goes to the owner, nothing is sent until they say yes, and then it goes out once with that approval
// checked. The service is a fake Google; the kernel, the gateway, the tasks and the records are real.
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
  // a write to an outside service is outward: the kernel asks, unless a standing yes covers it. An act the owner approved (a task, by id) satisfies the ask for that act only: the stand-in for
  // the kernel's approvedAct, recording each approval it is shown.
  const checked = [], binds = [];
  if (ask) {
    w.kernel.rules.push({ match: i => i.action === "service.call" && !i.approval, effect: "ask", reason: "outward" });
    w.kernel.rules.push({ match: i => { if (i.action === "service.call" && i.approval) { checked.push(i.approval); binds.push(i.bind); return true; } return false; }, effect: "allow", reason: "approved" });
  } else w.kernel.rules.push({ match: i => i.action === "service.call", effect: "allow", reason: "a standing yes" });
  const sent = [], all = [];
  let throttle = 0;
  const api = async (account, req) => {
    assert.equal(account, "home");
    all.push(`${req.method} ${req.path}`);
    if (req.method === "POST" && throttle > 0) { throttle--; return { status: 429, body: {} }; }
    const url = new URL(`https://www.googleapis.com${req.path}${req.query ? "?" + new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])) : ""}`);
    if (req.method !== "GET") sent.push({ method: req.method, path: req.path, body: req.body });
    const out = google.handle({ method: req.method, url, headers: { ...(req.headers || {}), authorization: `Bearer ${TOKEN}` }, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
    return { status: out.status, body: out.body ? JSON.parse(out.body) : {} };
  };
  const root = tempHome(t);
  const sync = createCalendarSyncHost({ root, log: () => {}, everyMs: 3_600_000, firstMs: 3_600_000 });
  t.after(() => sync.stop());
  const owner = () => w.kernel.chainFor({ flow: "calendar-sync", approver: ALEX, tainted: false, space: SPACE });
  const chains = { forDoer: x => w.kernel.moduleChain({ module: "flows", approver: x.approver }) };
  const h = sync.attach({ space: SPACE, gw: w.kernel, chains, ownerChain: owner, personChain: owner, ownerId: () => ALEX.id, subscribe: cb => w.kernel.onEvent(cb, "calendar-sync"), google: { accounts: async () => [{ name: "home" }], api } });
  const events = async () => (await w.kernel.records.query(owner(), "event", { page: { limit: 100 } })).rows;
  const tasks = async () => { await w.kernel.idle(); return w.kernel.tasks.filter(x => /Calendar:/.test(x.title)); };
  return { google, w, h, sent, all, checked, binds, events, tasks, owner, root, throttleNext: (/** @type {number} */ n) => { throttle = n; } };
}

test("by default it finds the connected Google account, pulls the outside calendar in, and an outside change comes in on the next look", async t => {
  const { google, h, events } = await rig(t);
  google.putEvent({ id: "sign1", summary: "Signing: Rivera trust", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" } });
  const out = await h.runNow();
  assert.equal(out["google-home"].pulled.created, 1);
  assert.equal((await events())[0].data.title, "Signing: Rivera trust");
  google.putEvent({ ...google.events.get("sign1"), summary: "Signing: Rivera trust (moved)", updated: undefined });
  await h.runNow();
  assert.equal((await events())[0].data.title, "Signing: Rivera trust (moved)");
});

test("with a standing yes a Vyre event goes out at once, tied to its outside id", async t => {
  const { google, w, h, sent, events, owner } = await rig(t);
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", source: "vyre" });
  const out = await h.runNow();
  assert.equal(out["google-home"].pushed.inserted, 1, JSON.stringify(out));
  assert.equal(google.events.size, 1); assert.equal(sent.length, 1);
  assert.match((await events())[0].data.external_id, /^[0-9a-f]{32}$/);
});

test("a write to the outside calendar is held for the owner's yes: a task, nothing sent, and once approved it goes out once with the approval", async t => {
  const { google, w, h, sent, checked, binds, events, tasks, owner } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  let out = await h.runNow();
  assert.equal(out["google-home"].pushed.held, 1, JSON.stringify(out));
  assert.equal(sent.length, 0, "nothing was sent"); assert.equal(google.events.size, 0);
  let ts = await tasks();
  assert.equal(ts.length, 1, "a task is in front of the owner");
  assert.equal(ts[0].checker.id, ALEX.id); assert.equal(ts[0].form.action, "service.call"); assert.match(ts[0].title, /Closing call/);
  // the card says everything that will be sent, not only the title: who is invited, when, and a digest the approval is tied to
  assert.match(ts[0].title, /2026-10-07T17:00:00.000Z to 2026-10-07T18:00:00.000Z/); assert.match(ts[0].title, /with sam@rivera.test/);
  assert.deepEqual([ts[0].form.input.people, ts[0].form.input.invites, ts[0].form.input.starts_at], [["sam@rivera.test"], true, "2026-10-07T17:00:00.000Z"]);
  assert.match(ts[0].form.digest, /^[0-9a-f]{16}$/); assert.match(ts[0].form.bind, /./);
  out = await h.runNow();
  assert.equal(out["google-home"].pushed.held, 1, "still waiting");
  assert.equal((await tasks()).length, 1, "and no second task");
  w.kernel.completeTask(ts[0].id, { outcome: "approved" });
  for (let i = 0; i < 50 && google.events.size < 1; i++) { await w.kernel.idle(); await new Promise(r => setTimeout(r, 20)); } // the approval itself starts the look
  assert.equal(sent.length, 1); assert.deepEqual(checked, [ts[0].id], "the approval was checked for this act before the write");
  assert.deepEqual(binds, [ts[0].form.bind], "and tied to the exact request that was asked about");
  assert.equal(google.events.size, 1);
  assert.equal((await events())[0].data.calendar, "google-home");
  out = await h.runNow();
  assert.deepEqual(out["google-home"].pushed, { inserted: 0, patched: 0, held: 0, refused: 0, conflicts: 0 }, "done: nothing more goes out");
  assert.equal(sent.length, 1);
});

test("a no from the owner is final for that change: nothing is sent and no new task is made", async t => {
  const { google, w, h, sent, tasks, owner } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Dentist", starts_at: "2026-10-07T17:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  await h.runNow();
  const [task] = await tasks();
  w.kernel.completeTask(task.id, { outcome: "rejected" });
  await w.kernel.idle();
  const out = await h.runNow();
  assert.equal(out["google-home"].pushed.refused, 1, JSON.stringify(out));
  await h.runNow();
  assert.equal(sent.length, 0); assert.equal(google.events.size, 0); assert.equal((await tasks()).length, 1);
});

test("a rule of the Space that refuses is a refusal: nothing is sent and nobody is asked", async t => {
  const { google, w, h, sent, tasks, owner } = await rig(t);
  w.kernel.rules.unshift({ match: i => i.action === "service.call", effect: "deny", reason: "rule_never", rule: { label: "Assistants never write to calendars" } });
  await w.kernel.records.create(owner(), "event", { title: "Dentist", starts_at: "2026-10-07T17:00:00.000Z", source: "vyre" });
  const out = await h.runNow();
  assert.equal(out["google-home"].pushed.refused, 1, JSON.stringify(out));
  assert.equal(sent.length, 0); assert.equal(google.events.size, 0); assert.equal((await tasks()).length, 0);
});

test("with no Google account connected it does nothing", async t => {
  const w = await world();
  t.after(() => w.stopListening());
  const sync = createCalendarSyncHost({ root: tempHome(t), log: () => {}, everyMs: 3_600_000, firstMs: 3_600_000 });
  t.after(() => sync.stop());
  const h = sync.attach({ space: SPACE, gw: w.kernel, chains: {}, ownerChain: () => w.kernel.sysChain(), personChain: () => w.kernel.sysChain(), ownerId: () => ALEX.id, google: { accounts: async () => [], api: async () => { throw new Error("must not be called"); } } });
  assert.deepEqual(await h.runNow(), {});
});

test("the owner's yes sends that change at once, without waiting for the next look; a no ends it at once too", async t => {
  const { google, w, h, sent, checked, tasks, owner } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  await w.kernel.records.create(owner(), "event", { title: "Dentist", starts_at: "2026-10-07T19:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  await h.runNow();
  const ts = await tasks();
  assert.equal(ts.length, 2);
  const yes = ts.find(x => /Closing call/.test(x.title)), no = ts.find(x => /Dentist/.test(x.title));
  w.kernel.completeTask(yes.id, { outcome: "approved" });
  w.kernel.completeTask(no.id, { outcome: "rejected" });
  // no runNow() here: the approval event starts the look
  for (let i = 0; i < 50 && google.events.size < 1; i++) { await w.kernel.idle(); await new Promise(r => setTimeout(r, 20)); }
  assert.equal(google.events.size, 1, "the approved change went out on the approval");
  assert.equal(sent.length, 1); assert.deepEqual(checked, [yes.id]);
  assert.match([...google.events.values()][0].summary, /Closing call/);
});

test("an event edited while its change waits is a new ask with the new details; the old yes cannot send the new body", async t => {
  const { google, w, h, sent, tasks, owner } = await rig(t, { ask: true });
  const e = await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  await h.runNow();
  const [first] = await tasks();
  await w.kernel.records.update(owner(), "event", e.id, { people: ["sam@rivera.test", "stranger@elsewhere.test"] }, e.version);
  w.kernel.completeTask(first.id, { outcome: "approved" });
  await w.kernel.idle(); await new Promise(r => setTimeout(r, 50));
  await h.runNow();
  assert.equal(google.events.size, 0, "the approval was for the old invitation list; nothing was sent");
  const ts = await tasks();
  assert.equal(ts.length, 2, "the new details are asked about again");
  assert.match(ts[1].title, /stranger@elsewhere.test/);
  assert.equal(sent.length, 0);
});

test("a connected Google account with a different name is synced the same way: events come in with source google, and a write is held, then goes out once approved with that approval checked", async t => {
  const google = fakeGoogle({ mailbox: "alex@harlow.test" });
  const w = await world();
  t.after(() => w.stopListening());
  w.kernel.rules.push({ match: i => i.action === "service.call" && !i.approval, effect: "ask", reason: "outward" });
  // an act the owner approved (a task, by id) is what satisfies the ask, for that act only: the stand-in for the kernel's approvedAct
  const checked = [];
  w.kernel.rules.push({ match: i => { if (i.action === "service.call" && i.approval) { checked.push(i.approval); return true; } return false; }, effect: "allow", reason: "approved" });
  const sent = [];
  const api = async (account, req) => {
    assert.equal(account, "work");
    const url = new URL(`https://www.googleapis.com${req.path}${req.query ? "?" + new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])) : ""}`);
    if (req.method !== "GET") sent.push(req.method + " " + req.path);
    const out = google.handle({ method: req.method, url, headers: { ...(req.headers || {}), authorization: `Bearer ${TOKEN}` }, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
    return { status: out.status, body: out.body ? JSON.parse(out.body) : {} };
  };
  const sync = createCalendarSyncHost({ root: tempHome(t), log: () => {}, everyMs: 3_600_000, firstMs: 3_600_000 });
  t.after(() => sync.stop());
  const owner = () => w.kernel.chainFor({ flow: "calendar-sync", approver: ALEX, tainted: false, space: SPACE });
  const chains = { forDoer: x => w.kernel.moduleChain({ module: "flows", approver: x.approver }) };
  const h = sync.attach({ space: SPACE, gw: w.kernel, chains, ownerChain: owner, personChain: owner, ownerId: () => ALEX.id, subscribe: cb => w.kernel.onEvent(cb, "calendar-sync"), google: { accounts: async () => [{ name: "work" }], api } });
  google.putEvent({ id: "sign1", summary: "Signing", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" } });
  let out = await h.runNow();
  assert.equal(out["google-work"].pulled.created, 1, JSON.stringify(out));
  const rows = async () => (await w.kernel.records.query(owner(), "event", { page: { limit: 50 } })).rows;
  assert.deepEqual([(await rows())[0].data.source, (await rows())[0].data.calendar], ["google", "google-work"]);
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  out = await h.runNow();
  assert.equal(out["google-work"].pushed.held, 1, JSON.stringify(out));
  assert.equal(sent.length, 0);
  await w.kernel.idle();
  const [task] = w.kernel.tasks.filter(x => /Calendar:/.test(x.title));
  w.kernel.completeTask(task.id, { outcome: "approved" });
  for (let i = 0; i < 50 && sent.length < 1; i++) { await w.kernel.idle(); await new Promise(r => setTimeout(r, 20)); }
  assert.deepEqual(sent, ["POST /calendar/v3/calendars/primary/events"], "sent once, on the approval event");
  assert.deepEqual(checked, [task.id], "the approval was checked for this act before the write");
  assert.ok((await rows()).some(r => r.data.title === "Closing call" && r.data.external_id));
});

test("outward comes from the declaration alone: an event with nobody invited is held for a yes just like one that invites people, and nothing is sent without it", async t => {
  const google = fakeGoogle({ mailbox: "alex@harlow.test" });
  const w = await world();
  t.after(() => w.stopListening());
  w.kernel.rules.push({ match: i => i.action === "service.call" && !i.approval, effect: "ask", reason: "outward" });
  const sent = [];
  const api = async (account, req) => {
    const url = new URL(`https://www.googleapis.com${req.path}${req.query ? "?" + new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)])) : ""}`);
    if (req.method !== "GET") sent.push({ path: req.path, body: req.body });
    const out = google.handle({ method: req.method, url, headers: { ...(req.headers || {}), authorization: `Bearer ${TOKEN}` }, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
    return { status: out.status, body: out.body ? JSON.parse(out.body) : {} };
  };
  const sync = createCalendarSyncHost({ root: tempHome(t), log: () => {}, everyMs: 3_600_000, firstMs: 3_600_000 });
  t.after(() => sync.stop());
  const owner = () => w.kernel.chainFor({ flow: "calendar-sync", approver: ALEX, tainted: false, space: SPACE });
  const h = sync.attach({ space: SPACE, gw: w.kernel, chains: { forDoer: x => w.kernel.moduleChain({ module: "flows", approver: x.approver }) }, ownerChain: owner, personChain: owner, ownerId: () => ALEX.id,
    subscribe: cb => w.kernel.onEvent(cb, "calendar-sync"), google: { accounts: async () => [{ name: "work" }], api } });
  await w.kernel.records.create(owner(), "event", { title: "Focus time", starts_at: "2026-10-07T09:00:00.000Z", source: "vyre" });
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  const out = await h.runNow();
  assert.deepEqual([out["google-work"].pushed.inserted, out["google-work"].pushed.held], [0, 2], JSON.stringify(out));
  assert.equal(sent.length, 0, "nothing was sent: an event write is outward whoever is invited");
  await w.kernel.idle();
  const ts = w.kernel.tasks.filter(x => /Calendar:/.test(x.title));
  assert.equal(ts.length, 2, "one held change per event, each waiting for the owner's yes");
});

test("a write that goes out is read back and compared with what was sent, and a mismatch stops it", async t => {
  const { google, w, h, sent, all, events, tasks, owner } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", source: "vyre" });
  await h.runNow();
  const ts = await tasks();
  w.kernel.completeTask(ts[0].id, { outcome: "approved" });
  for (let i = 0; i < 50 && google.events.size < 1; i++) { await w.kernel.idle(); await new Promise(r => setTimeout(r, 20)); }
  assert.equal(sent.length, 1);
  const post = all.findIndex(c => c.startsWith("POST /calendar/v3/calendars/primary/events"));
  assert.ok(post >= 0 && all.slice(post + 1).some(c => /^GET \/calendar\/v3\/calendars\/primary\/events\/[0-9a-f]+/.test(c)), `the new event was read back after the write: ${JSON.stringify(all.slice(post))}`);
  assert.equal((await events())[0].data.calendar, "google-home", "and it matched, so the record is tied to the outside id");
});


test("a change to an event pulled from Google that has guests is still asked about: the pull keeps the attendees as people, so the patch invites", async t => {
  const { google, w, h, sent, events, tasks, owner } = await rig(t, { ask: true });
  google.putEvent({ id: "sign1", summary: "Signing", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" }, attendees: [{ email: "sam@rivera.test" }] });
  await h.runNow();
  const [row] = await events();
  assert.deepEqual(row.data.people, ["sam@rivera.test"], "the guests came in as people");
  await w.kernel.records.update(owner(), "event", row.id, { title: "Signing (moved)" }, row.version);
  const out = await h.runNow();
  assert.equal(out["google-home"].pushed.held, 1, JSON.stringify(out));
  assert.equal(sent.length, 0, "nothing was patched without a yes");
  assert.equal((await tasks()).length, 1);
});

test("an approved write that has to wait is not lost: a 429 after the yes keeps it, and the next look sends it once, without asking the kernel for the yes again", async t => {
  const { google, w, h, sent, all, checked, events, tasks, owner, throttleNext } = await rig(t, { ask: true });
  await w.kernel.records.create(owner(), "event", { title: "Closing call", starts_at: "2026-10-07T17:00:00.000Z", ends_at: "2026-10-07T18:00:00.000Z", source: "vyre" });
  await h.runNow();
  const ts = await tasks();
  throttleNext(1);
  w.kernel.completeTask(ts[0].id, { outcome: "approved" });
  for (let i = 0; i < 50 && !all.some(c => c.startsWith("POST")); i++) { await w.kernel.idle(); await new Promise(r => setTimeout(r, 20)); }
  assert.ok(all.some(c => c.startsWith("POST")), "the write was tried");
  assert.equal(sent.length, 0, "and the service answered 429, so nothing was made");
  assert.equal(google.events.size, 0);
  assert.deepEqual(checked, [ts[0].id], "the yes was spent once");
  // the next look sends the same request without asking the kernel for the yes again
  const out = await h.runNow();
  assert.equal(google.events.size, 1, JSON.stringify(out));
  assert.deepEqual(checked, [ts[0].id], "the yes was not asked for twice");
  assert.equal((await events())[0].data.calendar, "google-home");
  await h.runNow();
  assert.equal(google.events.size, 1, "once");
});
