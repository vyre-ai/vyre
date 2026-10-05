// @ts-check
// The calendar sync on a REAL vyred (kernel on) with a Google account connected to the google module (a service account in the vault, the fake Google as its base): the account's calendar is
// pulled into Event records with source "google", and what the person makes in Vyre is pushed back only through the approval path. Never real Google.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "./index.js";
import { call } from "./client.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeGoogle } from "../../lib/connectors/testing/fake-google.js";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.TZ = "UTC";
const ME = "alex@example.com";

// the kernel's check of a signed decision (as test/kits-restart-daemon.test.js): the proof must be for exactly this op and these fields, once
const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };

async function world(/** @type {any} */ t) {
  const fake = await startFakeGoogle(t);
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: signedPresence() });
  t.after(() => d.stop());
  const cli = (/** @type {string} */ tool, input = {}) => call(tool, input, { root, caller: "cli" });
  assert.ok((await cli("vault.put", { name: "work-google", kind: "secret", fields: { value: fake.serviceAccount(ME) } })).data);
  assert.equal((await cli("vault.grant", { name: "work-google", module: "google" })).data.grant.status, "active");
  const added = await cli("google.add", { name: "work", email: ME, auth: { type: "service-account", item: "work-google" }, base: fake.base });
  assert.ok(added.data, JSON.stringify(added));
  const owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const sync = () => d.registry.deps.flowsHost.get(d.kernel.id.space).calendar;
  const events = async () => (await d.kernel.gateway.records.query(admin, "event", { page: { limit: 100 } })).rows;
  return { fake, d, cli, admin, sync, events };
}

test("a connected Google account's calendar lands as Event records with source google, and an outside change comes in on the next look", { timeout: 120_000 }, async t => {
  const { fake, sync, events } = await world(t);
  assert.ok(sync(), "the sync is started for the Space by default");
  const out = await sync().runNow();
  assert.ok(out["google-work"] && !out["google-work"].error, JSON.stringify(out));
  const rows = await events();
  assert.ok(rows.length >= 2, `the account's events came in: ${rows.length}`);
  assert.ok(rows.every((/** @type {any} */ r) => r.data.source === "google" && r.data.calendar === "google-work" && r.data.external_id));
  assert.ok(rows.some((/** @type {any} */ r) => r.data.title === "Harlow Legal check-in"));
  assert.ok(rows.every((/** @type {any} */ r) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.data.starts_at)), "starts_at is an ISO UTC string");
  // nothing was written outward by a pull
  assert.equal(fake.calls.filter((/** @type {any} */ c) => c.method !== "GET" && !/token/.test(c.path)).length, 0);
  // an event added on the Google side comes in at the next look
  fake.calendar.events.push({ kind: "calendar#event", id: "evnew1", status: "confirmed", summary: "Rivera signing", start: { dateTime: new Date(Date.now() + 5 * 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString() }, updated: new Date().toISOString() });
  await sync().runNow();
  assert.ok((await events()).some((/** @type {any} */ r) => r.data.title === "Rivera signing" && r.data.source === "google"));
});

test("an event made in Vyre is pushed to the Google account only through the approval path: nothing is sent until the owner says yes", { timeout: 120_000 }, async t => {
  const { fake, d, admin, sync, events } = await world(t);
  await sync().runNow();
  const before = fake.calendar.events.length;
  await d.kernel.gateway.records.create(admin, "event", { title: "Closing call", starts_at: "2026-10-20T17:00:00.000Z", ends_at: "2026-10-20T18:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  const out = await sync().runNow();
  const pushed = out["google-work"].pushed;
  assert.equal(pushed.inserted + pushed.held + pushed.refused, 1, JSON.stringify(out));
  assert.equal(pushed.inserted, 0, "not sent without a yes: " + JSON.stringify(pushed));
  assert.equal(fake.calendar.events.length, before, "Google was not written");
  assert.ok(!(await events()).some((/** @type {any} */ r) => r.data.title === "Closing call" && r.data.external_id));
});

// REPRODUCTION (fails today): on the real kernel an approved held write is never allowed, because approvedAct needs the acting chain to be the task's doer (service:flows), which holds no
// service.call grant. Expected once approvedAct is fixed: the approved write goes out once, and an approval for one body is refused for another.
test("on the real kernel the owner's yes lets exactly that write go out, once", { timeout: 120_000 }, async t => {
  const { fake, d, admin, sync } = await world(t);
  await sync().runNow();
  const gw = d.kernel.gateway;
  await gw.records.create(admin, "event", { title: "Closing call", starts_at: "2026-10-20T17:00:00.000Z", ends_at: "2026-10-20T18:00:00.000Z", people: ["sam@rivera.test"], source: "vyre" });
  const out = await sync().runNow();
  assert.equal(out["google-work"].pushed.held, 1, JSON.stringify(out));
  const task = (await gw.ask.list(admin, {})).find((/** @type {any} */ x) => /Calendar:/.test(x.title));
  const row = await gw.ask.get(admin, task.id);
  await gw.ask.decide(admin, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  const before = fake.calendar.events.length;
  for (let i = 0; i < 100 && fake.calendar.events.length < before + 1; i++) await new Promise(r => setTimeout(r, 100));
  await sync().runNow();
  assert.equal(fake.calendar.events.length, before + 1, "the approved write went out once");
});

test("google.api is for Vyre's own modules, Calendar events and Gmail reads only: a model or a person's surface is refused, and so is any other Google path or a write to Gmail", { timeout: 60_000 }, async t => {
  const { d, cli } = await world(t);
  const as = (/** @type {string} */ caller, input = {}) => d.registry.call("google.api", { account: "work", method: "GET", path: "/calendar/v3/calendars/primary/events", ...input }, caller);
  assert.ok((await as("mcp")).error, "a model is refused");
  assert.ok((await cli("google.api", { account: "work", method: "GET", path: "/calendar/v3/calendars/primary/events" })).error, "so is a person's surface: the tool is not theirs");
  assert.equal((await as("module:leases")).data.status, 200);
  for (const path of ["/calendar/v3/users/me/calendarList", "/gmail/v1/users/me/drafts", "/calendar/v3/calendars/x/events/..", "/calendar/v3/calendars/x/events/%2e%2e", "/calendar/v3/calendars/x/events/a%2Fb", "/gmail/v1/users/me/messages/a/b", "/calendar/v3/calendars/primary/acl", "/calendar/v3/calendars/primary/events/a/b"]) assert.equal((await as("module:leases", { path })).error?.code, "bad_input", path);
  for (const path of ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/send", "/gmail/v1/users/me/drafts/send"]) for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await as("module:leases", { path, method })).error?.code, "bad_input", `${method} ${path}: Gmail through here is a read, never a write`);
  assert.equal((await as("module:leases", { path: "/gmail/v1/users/me/messages" })).data.status, 200, "a Gmail read is let through");
  assert.equal((await as("module:leases", { path: "/calendar/v3/calendars/alex%40example.com/events" })).data.status, 200, "an address as the calendar id is fine");
  assert.equal((await as("module:watchers", { method: "POST", body: {} })).error?.code, "denied", "a watcher only reads");
  assert.equal((await as("module:watchers")).data.status, 200, "and may read");
  assert.equal((await as("module:gate", { path: "/calendar/v3/calendars/primary/events" })).error?.code, "denied", "no other module calls it");
  assert.equal((await as("module:leases", { account: "nope" })).error?.code, "not_found");
});
