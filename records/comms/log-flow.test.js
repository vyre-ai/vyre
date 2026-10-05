import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createRecordsHost } from "../host.js";
import { logCommunicationsFlow } from "./log-flow.js";
import { timelineOf, addContactPoint } from "./log.js";
import { checkFlow } from "../../kernel/flows/schema.js";
import { mapItem } from "../connectors/mapper.js";
import { DECLARATIONS } from "../connectors/index.js";
import { fakeGoogle } from "../testing/fake-google.js";

const SPACE = "spc_harlow000001", MAILBOX = "alex@harlow.test", WATCHER = "gmail-alex-harlow-test";
const mailMap = DECLARATIONS.gmail.poll["mail.recent"].map, calMap = DECLARATIONS["google-calendar"].poll["events.changed"].map;

/** what the generic poll watcher files for a raw answer: the mapped fields beside id, title and at (ms), and the time as text in `occurred`, as watchers.items returns it */
const filed = (raw, map, vars, idOf) => { const m = mapItem(raw, map, vars); return { ...m, id: idOf(raw), title: m.title ?? m.subject, at: Date.parse(m.at), occurred: m.at, watcher: WATCHER, project: "harlow-legal", kind: "gmail.found" }; };

async function rig(o = {}) {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  const flow = logCommunicationsFlow({ watcher: WATCHER, ...o });
  assert.deepEqual(checkFlow(flow), [], "the stored Flow is well formed");
  const d = await host.flows.runner.define(null, flow, host.person);
  assert.ok(d.ok, JSON.stringify(d.errors));
  await host.flows.runner.approve(d.id, d.version, host.person, d.hash);
  const R = host.kernel.records, chain = () => host.ownerChain();
  const all = async type => (await R.query(chain(), type, { page: { limit: 200 } })).rows;
  const feed = async item => { const r = await host.flows.runner.watcherItem({ watcher: WATCHER, item }); await host.settle(); return r; };
  const google = fakeGoogle({ mailbox: MAILBOX });
  return { host, R, chain, all, feed, google, flow };
}
const msg = (google, m) => google.handle({ method: "GET", url: new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${google.addMessage(m).id}?format=metadata`), headers: { authorization: "Bearer ya29.fake-connector-token" } }).body;
const rawOf = (google, m) => JSON.parse(msg(google, m));

test("an email is filed once as a Communication, with a participant for each person, linked to the contact by main email, by a further address, or kept bare", async () => {
  const { host, R, chain, all, feed, google } = await rig();
  const jane = await R.create(chain(), "contact", { name: "Jane Doe", email: "jane@client.test" });
  const bob = await R.create(chain(), "contact", { name: "Bob Firm", email: "bob@firm.test" });
  assert.equal((await addContactPoint(host.kernel, chain(), bob.urn, "bob.personal@home.test")).created, true);
  const raw = rawOf(google, { from: "Jane Doe <Jane@Client.test>", to: `${MAILBOX}, bob.personal@home.test`, cc: "stranger@elsewhere.test", subject: "Trust signing Thursday", snippet: "Can we move it to 10?" });
  const item = filed(raw, mailMap, { mailbox: MAILBOX }, r => r.id);
  const r = await feed(item);
  assert.ok(r, "the Flow ran");
  const comms = await all("communication");
  assert.equal(comms.length, 1);
  assert.deepEqual([comms[0].data.kind, comms[0].data.direction, comms[0].data.subject, comms[0].data.mailbox, comms[0].data.thread], ["email", "inbound", "Trust signing Thursday", MAILBOX, raw.threadId]);
  assert.equal(comms[0].data.source_key, `gmail:${MAILBOX}:${raw.id}`);
  assert.equal(comms[0].data.at, item.occurred);
  assert.match(comms[0].data.original_url, /mail\.google\.com/);
  const parts = await all("participant");
  const byAddr = Object.fromEntries(parts.map(p => [`${p.data.how}:${p.data.address}`, p.data.contact && p.data.contact.urn]));
  assert.deepEqual(byAddr, {
    "from:jane@client.test": jane.urn,
    [`to:${MAILBOX}`]: undefined,
    "to:bob.personal@home.test": bob.urn,
    "cc:stranger@elsewhere.test": undefined,
  }, "main email, a further address (contact point), and bare addresses with no contact");
  assert.equal((await all("contact")).length, 2, "no contact was made for a stranger: off to start");
  // the Communication links straight to each Contact on it (many to many), beside the Participants; a stranger with no contact adds nothing
  assert.deepEqual(comms[0].data.contacts.map((/** @type {any} */ c) => c.urn).sort(), [bob.urn, jane.urn].sort());
  // and the Contact shows it as "Communications" (the named reverse)
  const via = async (/** @type {string} */ urn) => (await R.linked(chain(), urn, { type: "communication" })).rows.filter((/** @type {any} */ r) => r.field === "contacts");
  const onJane = await via(jane.urn);
  assert.equal(onJane.length, 1, "the reverse link on the Contact: " + JSON.stringify(onJane));
  assert.deepEqual(onJane[0].inverse, { name: "communications", label: "Communications" });
  assert.equal((await via(bob.urn)).length, 1, "on Bob too");
  // the timeline on the contact shows it, from both of Bob's addresses
  assert.equal((await timelineOf(host.kernel, chain(), jane.urn)).length, 1);
  assert.equal((await timelineOf(host.kernel, chain(), bob.urn)).length, 1);
  // the same item again (the watcher saw it twice, or the run was retried): nothing doubles
  await feed(item);
  assert.equal((await all("communication")).length, 1); assert.equal((await all("participant")).length, 4);
  assert.equal((await all("communication"))[0].data.contacts.length, 2, "and the links are not doubled");
});

test("a reply from the mailbox is outbound and files on the contact it was sent to; a changed meeting updates its Communication and adds the new attendee", async () => {
  const { R, chain, all, feed, google } = await rig();
  const jane = await R.create(chain(), "contact", { name: "Jane Doe", email: "jane@client.test" });
  const reply = filed(rawOf(google, { from: `Alex <${MAILBOX}>`, to: "jane@client.test", subject: "Re: Trust signing", snippet: "Yes." }), mailMap, { mailbox: MAILBOX }, r => r.id);
  await feed(reply);
  assert.equal((await all("communication"))[0].data.direction, "outbound");
  assert.equal((await all("participant")).find(p => p.data.how === "to").data.contact.urn, jane.urn);
  // a meeting: kind meeting, no direction, attendees by address
  const ev = google.putEvent({ id: "sign1", summary: "Signing: Rivera trust", start: { dateTime: "2026-10-08T16:00:00Z" }, end: { dateTime: "2026-10-08T17:00:00Z" }, organizer: { email: MAILBOX }, attendees: [{ email: "jane@client.test" }] });
  const meet = filed(ev, calMap, { calendar: MAILBOX }, r => `${r.id}:${r.updated}`);
  await feed(meet);
  let comms = (await all("communication")).filter(c => c.data.kind === "meeting");
  assert.equal(comms.length, 1); assert.equal(comms[0].data.direction ?? null, null); assert.equal(comms[0].data.at, "2026-10-08T16:00:00.000Z");
  const moved = google.putEvent({ ...ev, updated: undefined, summary: "Signing: Rivera trust (moved)", attendees: [{ email: "jane@client.test" }, { email: "sam@rivera.test" }] });
  await feed(filed(moved, calMap, { calendar: MAILBOX }, r => `${r.id}:${r.updated}`));
  comms = (await all("communication")).filter(c => c.data.kind === "meeting");
  assert.equal(comms.length, 1, "the same event is the same communication"); assert.equal(comms[0].data.subject, "Signing: Rivera trust (moved)");
  const mp = (await all("participant")).filter(p => p.data.communication.urn === comms[0].urn);
  assert.deepEqual(mp.map(p => `${p.data.how}:${p.data.address}`).sort(), [`attendee:jane@client.test`, "attendee:sam@rivera.test", `organizer:${MAILBOX}`]);
  assert.equal((await timelineOf({ records: R }, chain(), jane.urn)).length, 2, "an email and a meeting on one timeline, newest first");
});

test("the switches: createUnknown makes the contact once; skipInternal leaves colleagues off", async () => {
  const a = await rig({ createUnknown: true });
  const raw = rawOf(a.google, { from: "New Person <new@person.test>", subject: "Hello", snippet: "Hi" });
  await a.feed(filed(raw, mailMap, { mailbox: MAILBOX }, r => r.id));
  const made = (await a.all("contact")).filter(c => c.data.email === "new@person.test");
  assert.equal(made.length, 1);
  const p = (await a.all("participant")).find(x => x.data.address === "new@person.test");
  assert.equal(p.data.contact.urn, made[0].urn);
  const raw2 = rawOf(a.google, { from: "new@person.test", subject: "Again", snippet: "" });
  await a.feed(filed(raw2, mailMap, { mailbox: MAILBOX }, r => r.id));
  assert.equal((await a.all("contact")).filter(c => c.data.email === "new@person.test").length, 1, "found, not made again");

  const b = await rig({ skipInternal: "harlow.test" });
  await b.feed(filed(rawOf(b.google, { from: "jane@client.test", to: `${MAILBOX}, colleague@harlow.test`, subject: "Hi" }), mailMap, { mailbox: MAILBOX }, r => r.id));
  assert.deepEqual((await b.all("participant")).map(x => x.data.address), ["jane@client.test"], "mail to colleagues is not filed as a person");
});

test("the Flow's name and trigger come from the watcher; a bad watcher name is refused", () => {
  const f = logCommunicationsFlow({ watcher: "gmail-alex-harlow-test" });
  assert.equal(f.trigger.watcher, "gmail-alex-harlow-test"); assert.match(f.name, /^log_comms_gmail_alex_harlow_test$/);
  assert.throws(() => logCommunicationsFlow({ watcher: "Bad Name" }), /name the watcher/);
});
