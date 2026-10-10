// @ts-check
// A poll from any connector's declaration (records/connectors) as a watcher, with no per-service watcher code: the Gmail, Google Calendar and Stripe declarations, run by the one generic loop in a
// real watcher child, against a fake Google reached through the google module's api (the `google` port: a connected account, read only) and a fake Stripe reached through the vault's read (the
// `request` port). A real child and a real store: a hosted runner, never the person's Mac.
import "../../scripts/mac-test-guard.mjs";
import { test as nodeTest } from "node:test";
import { skipOffRunner } from "../../lib/sandbox/test-host.js";
const offMac = skipOffRunner();
const test = (/** @type {string} */ name, /** @type {any} */ fn) => nodeTest(name, { skip: offMac }, fn);
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { testHooks, OPEN_WALL } from "../../lib/sandbox/index.js";
testHooks.wall = OPEN_WALL;
import { open, migrate } from "../store/index.js";
import { Runtime, MIGRATIONS, LATE_MIGRATIONS } from "./runtime.js";
import { tempHome } from "../../test/helpers.js";
import { fakeGoogle, TOKEN } from "../../records/testing/fake-google.js";
import { fakeStripe, KEY } from "../../records/testing/fake-stripe.js";

const MAILBOX = "alex@harlow.test";
const T0 = Date.now(), at = (/** @type {number} */ min) => T0 + min * 60_000;

function setup(/** @type {any} */ t, /** @type {{ google: any, stripe?: any }} */ { google, stripe }) {
  const root = tempHome(t), db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "watchers", [...MIGRATIONS, ...LATE_MIGRATIONS]);
  const dir = path.join(root, "watchers"); fs.mkdirSync(dir);
  // the child reads the real clock for its cursor, so the test's world is placed relative to it
  const clock = { now: Date.now() };
  const taught = /** @type {any[]} */ ([]), seen = /** @type {any[]} */ ([]);
  // the vault's read: the fake service for the host, with the credential's key added the way the vault adds it
  const request = async (/** @type {any} */ i) => {
    const u = new URL(i.url); seen.push(`${i.method} ${u.hostname}${u.pathname}${u.search}`);
    const f = u.hostname === "api.stripe.com" ? { h: stripe, key: KEY } : { h: google, key: TOKEN };
    const out = f.h.handle({ method: i.method, url: u, headers: { ...(i.headers || {}), authorization: `Bearer ${f.key}` }, body: i.body });
    return { kind: "read", status: out.status, headers: out.headers, body: out.body };
  };
  // the google module's read for a connected account: Gmail and Calendar reads only, the token added the way the module adds it
  const googleApi = async (/** @type {any} */ i) => {
    assert.equal(i.account, "work"); assert.equal(i.method, "GET");
    const host = i.path.startsWith("/gmail/") ? "gmail.googleapis.com" : "www.googleapis.com";
    const q = new URLSearchParams(); for (const [k, v] of Object.entries(i.query || {})) for (const x of [].concat(/** @type {any} */ (v))) q.append(k, String(x));
    const u = new URL(`https://${host}${i.path}${q.size ? "?" + q : ""}`); seen.push(`GET ${host}${u.pathname}${u.search}`);
    const out = google.handle({ method: "GET", url: u, headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: out.status, body: out.body ? JSON.parse(out.body) : {} };
  };
  const rt = new Runtime({
    db, dir, now: () => clock.now, log: () => {}, request, google: googleApi, googleGranted: async () => true, netOptions: () => testHooks.net, wall: () => testHooks.wall,
    emit: () => {}, call: async (/** @type {string} */ tool) => tool === "projects.list" ? { data: { projects: [{ slug: "harlow-legal", name: "Harlow Legal", home: "/work/harlow-legal", workspaces: ["/work/harlow-legal"] }] } } : { error: { code: "no_such_tool" } },
    fetch: async () => "unused", teach: async (/** @type {string} */ kind, /** @type {any} */ fact) => { taught.push({ kind, ...fact }); return true; },
  });
  t.after(() => rt.stop());
  return { rt, clock, taught, seen, dir };
}
const tick = async (/** @type {any} */ s, /** @type {number} */ minutes = 6) => { s.clock.now += minutes * 60_000; s.rt.tick(); await s.rt.settle(); };

test("a Gmail poll starts quiet, then files each new message with its people, direction and source key, once, and teaches Memory nothing", async t => {
  const google = fakeGoogle({ mailbox: MAILBOX });
  google.addMessage({ from: "Jane Doe <jane@client.test>", subject: "Before the poll", at: at(-60) });
  const s = setup(t, { google });
  const made = await s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", google: "work", vars: { mailbox: MAILBOX } });
  assert.equal(made.name, "gmail-alex-harlow-test");
  assert.deepEqual(made.facts.reads, ["gmail.googleapis.com"]);
  assert.match(made.lines.do, /Nothing in Gmail is changed/);
  await s.rt.create(made.name, { hash: made.hash }); await s.rt.settle();
  assert.equal(s.seen.length, 0, "the first run only notes where to start");

  google.addMessage({ from: "Jane Doe <Jane@Client.test>", to: `${MAILBOX}, bob@firm.test`, cc: "carol@court.test", subject: "Trust signing Thursday", snippet: "Can we move it to 10?", at: at(3) });
  google.addMessage({ from: `Alex <${MAILBOX}>`, to: "jane@client.test", subject: "Re: Trust signing Thursday", snippet: "Yes, 10 works.", at: at(5) });
  await tick(s);
  const items = s.rt.items({ name: made.name }).sort((a, b) => a.at - b.at);
  assert.equal(items.length, 2);
  const [inbound, outbound] = items;
  assert.equal(inbound.comm_kind, "email"); assert.equal(inbound.direction, "inbound"); assert.equal(outbound.direction, "outbound");
  assert.equal(inbound.subject, "Trust signing Thursday");
  assert.deepEqual(inbound.people, [{ address: "jane@client.test", how: "from" }, { address: MAILBOX, how: "to" }, { address: "bob@firm.test", how: "to" }, { address: "carol@court.test", how: "cc" }]);
  assert.match(inbound.source_key, /^gmail:alex@harlow\.test:18f\d+$/);
  assert.match(inbound.original_url, /^https:\/\/mail\.google\.com\/mail\/u\/alex@harlow\.test\/#all\/18f/);
  assert.equal(s.taught.length, 0, "a log of mail is for the records: memory: false");
  assert.ok(s.seen.every(x => x.startsWith("GET ")), "the generic loop only ever reads: " + s.seen.join(" | "));
  assert.ok(s.seen.some(x => /messages\?q=after%3A\d+&maxResults=50/.test(x)));
  assert.ok(s.seen.some(x => /messages\/18f\d+\?format=metadata&metadataHeaders=From&metadataHeaders=To/.test(x)), "each message is read for its headers only, not its body");
  // looked at again: the same messages are not filed twice
  await tick(s);
  assert.equal(s.rt.items({ name: made.name }).length, 2);
  google.addMessage({ from: "dana@client.test", subject: "One more", at: at(20) });
  await tick(s);
  assert.equal(s.rt.items({ name: made.name }).length, 3);
});

test("a Calendar poll files an event once, and a changed event is a new item with the same source key", async t => {
  const google = fakeGoogle({ mailbox: MAILBOX });
  const s = setup(t, { google });
  const made = await s.rt.createPreset({ kind: "connector", connector: "google-calendar", poll: "events.changed", project: "harlow-legal", google: "work", vars: { calendar: MAILBOX } });
  await s.rt.create(made.name, { hash: made.hash }); await s.rt.settle();
  const later = () => new Date(s.clock.now + 5 * 60_000).toISOString();
  google.putEvent({ updated: later(), id: "sign1", summary: "Signing: Rivera trust", description: "Bring ID", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" },
    organizer: { email: MAILBOX }, attendees: [{ email: "Sam@Rivera.test" }, { email: MAILBOX }] });
  await tick(s, 16);
  let items = s.rt.items({ name: made.name });
  assert.equal(items.length, 1);
  assert.equal(items[0].comm_kind, "meeting"); assert.equal(items[0].source_key, `gcal:${MAILBOX}:sign1`);
  assert.equal(items[0].at, Date.parse("2026-10-08T16:00:00Z"));
  assert.deepEqual(items[0].people.map(p => `${p.how}:${p.address}`), [`organizer:${MAILBOX}`, "attendee:sam@rivera.test", `attendee:${MAILBOX}`]);
  assert.match(s.seen.at(-1), /calendars\/alex%40harlow\.test\/events\?updatedMin=.*&singleEvents=true&maxResults=100/);
  await tick(s, 16);
  assert.equal(s.rt.items({ name: made.name }).length, 1, "nothing changed, nothing filed");
  s.clock.now += 0;
  google.putEvent({ ...google.events.get("sign1"), summary: "Signing: Rivera trust (moved)", updated: later() });
  await tick(s, 16);
  items = s.rt.items({ name: made.name });
  assert.equal(items.length, 2, "a change is a new item");
  assert.equal(new Set(items.map(i => i.source_key)).size, 1, "and the same communication to the logging Flow");
});

test("the same loop polls Stripe: no watcher code for a service that is only a declaration", async t => {
  const stripe = fakeStripe(), google = fakeGoogle();
  const s = setup(t, { google, stripe });
  const made = await s.rt.createPreset({ kind: "connector", connector: "stripe", poll: "payments.recent", project: "harlow-legal", credential: "stripe", label: "payments" });
  await s.rt.create(made.name, { hash: made.hash }); await s.rt.settle();
  stripe.addIntent({ description: "Trust package", created: Math.floor((s.clock.now + 60_000) / 1000), customer: "cus_9" });
  await tick(s, 16);
  const items = s.rt.items({ name: made.name });
  assert.equal(items.length, 1);
  assert.equal(items[0].comm_kind, "payment"); assert.equal(items[0].amount, 350000); assert.equal(items[0].currency, "usd");
  assert.match(s.seen.at(-1), /payment_intents\?created%5Bgte%5D=\d+&limit=100/);
});

test("a poll that is missing something it needs, or does not exist, is refused when it is written, not when it first runs", async t => {
  const s = setup(t, { google: fakeGoogle() });
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", google: "work" }), /needs mailbox/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", google: "work", vars: { mailbox: MAILBOX, other: "x" } }), /no use for other/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "nope", project: "harlow-legal", google: "work", vars: { mailbox: MAILBOX } }), /has no poll nope/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "clio", poll: "x", project: "harlow-legal", credential: "c" }), /connector this build declares/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", vars: { mailbox: MAILBOX } }), /name it \(google/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", credential: "gmail", google: "work", vars: { mailbox: MAILBOX } }), /has no vault credential/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "stripe", poll: "payments.recent", project: "harlow-legal" }), /needs credential/);
  await assert.rejects(s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", google: "work", vars: { mailbox: MAILBOX }, when: "every 1 minutes" }), /schedule|minutes/);
});

test("G-1: a Google watcher reads nothing until a person grants the account to it, for a dry run as for a run", async t => {
  const google = fakeGoogle({ mailbox: MAILBOX });
  const s = setup(t, { google });
  let granted = false;
  s.rt.d.googleGranted = async (/** @type {string} */ account, /** @type {string} */ watcher) => granted && account === "work" && watcher === "gmail-alex-harlow-test";
  s.rt.d.googleItem = async () => "work-google";
  const made = await s.rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", google: "work", lookback_days: 1, vars: { mailbox: MAILBOX } });
  assert.equal(made.grant, "vyre vault grant work-google watchers --watcher gmail-alex-harlow-test");
  google.addMessage({ from: "jane@client.test", subject: "Hello", at: at(-5) });
  const before = await s.rt.test(made.name);
  assert.match(JSON.stringify(before), /not granted to this watcher/);
  assert.equal(s.seen.length, 0, "nothing was read");
  granted = true;
  const after = await s.rt.test(made.name);
  assert.doesNotMatch(JSON.stringify(after), /not granted/);
  assert.ok(s.seen.length > 0, "with the grant it reads");
});
