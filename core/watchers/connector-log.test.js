// @ts-check
// The whole path of "Log communications", with nothing between the pieces faked but the services and the clock: a fake Google mailbox and calendar, the connector preset's poll running in a real
// watcher child, the watcher bridge handing each filed item to the Flows runner, and the default Flow filing Communications and Participants on contacts in a records host. A real child and a
// real store: a hosted runner, never the person's Mac.
import "../../scripts/mac-test-guard.mjs";
import { test as nodeTest } from "node:test";
import { skipOffRunner } from "../../lib/sandbox/test-host.js";
const offMac = skipOffRunner();
const test = (/** @type {string} */ name, /** @type {any} */ fn) => nodeTest(name, { skip: offMac }, fn);
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { testHooks, OPEN_WALL } from "../../lib/sandbox/index.js";
testHooks.wall = OPEN_WALL;
import { open, migrate } from "../store/index.js";
import { Runtime, MIGRATIONS, LATE_MIGRATIONS } from "./runtime.js";
import { tempHome } from "../../test/helpers.js";
import { fakeGoogle, TOKEN } from "../../records/testing/fake-google.js";
import { createRecordsHost } from "../../records/host.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { bridgeWatchers } from "../../kernel/flows/watcher-bridge.js";
import { logCommunicationsFlow } from "../../records/comms/log-flow.js";
import { timelineOf } from "../../records/comms/log.js";

const MAILBOX = "alex@harlow.test", T0 = Date.now(), at = (/** @type {number} */ min) => T0 + min * 60_000;

test("mail and meetings found by the poll watchers land on the contacts' timelines through the default Flow, once each", async t => {
  const google = fakeGoogle({ mailbox: MAILBOX });
  const root = tempHome(t), db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "watchers", [...MIGRATIONS, ...LATE_MIGRATIONS]);
  const dir = path.join(root, "watchers"); fs.mkdirSync(dir);
  const clock = { now: Date.now() };
  const bus = new EventEmitter();
  // the google module's read for a connected account (Gmail and Calendar reads only)
  const googleApi = async (/** @type {any} */ i) => {
    const q = new URLSearchParams(); for (const [k, v] of Object.entries(i.query || {})) for (const x of [].concat(/** @type {any} */ (v))) q.append(k, String(x));
    const host = i.path.startsWith("/gmail/") ? "gmail.googleapis.com" : "www.googleapis.com";
    const out = google.handle({ method: "GET", url: new URL(`https://${host}${i.path}${q.size ? "?" + q : ""}`), headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: out.status, body: out.body ? JSON.parse(out.body) : {} };
  };
  const rt = new Runtime({
    db, dir, now: () => clock.now, log: () => {}, google: googleApi, googleGranted: async () => true, netOptions: () => testHooks.net, wall: () => testHooks.wall,
    emit: (/** @type {string} */ type, /** @type {any} */ payload) => { bus.emit(type, payload); },
    call: async (/** @type {string} */ tool) => tool === "projects.list" ? { data: { projects: [{ slug: "harlow-legal", name: "Harlow Legal", home: "/work/harlow-legal", workspaces: ["/work/harlow-legal"] }] } } : { error: { code: "no_such_tool" } },
    fetch: async () => "unused", teach: async () => true,
  });
  t.after(() => rt.stop());

  // the records host with the default Flow for the mailbox and the calendar, each armed on the watcher the preset makes
  const host = createRecordsHost({ space: "spc_harlow000001", owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  const mail = await rt.createPreset({ kind: "connector", connector: "gmail", poll: "mail.recent", project: "harlow-legal", google: "work", vars: { mailbox: MAILBOX } });
  const cal = await rt.createPreset({ kind: "connector", connector: "google-calendar", poll: "events.changed", project: "harlow-legal", google: "work", vars: { calendar: MAILBOX } });
  for (const w of [mail, cal]) {
    const d = await host.flows.runner.define(null, logCommunicationsFlow({ watcher: w.name }), host.person);
    assert.ok(d.ok, JSON.stringify(d.errors));
    await host.flows.runner.approve(d.id, d.version, host.person, d.hash);
  }
  // the bridge as the Flows module wires it: a watcher that filed something starts the Flows armed on it, reading the items back as the watchers tool shows them
  bridgeWatchers({ runner: host.flows.runner, on: (type, fn) => { bus.on(type, fn); return () => bus.off(type, fn); }, call: async (tool, input) => (tool === "watchers.items" ? rt.items({ name: input.name, limit: input.limit }) : []) });
  for (const w of [mail, cal]) { await rt.create(w.name, { hash: w.hash }); await rt.settle(); }

  const R = host.kernel.records, chain = () => host.ownerChain();
  const jane = await R.create(chain(), "contact", { name: "Jane Doe", email: "jane@client.test" });
  google.addMessage({ from: "Jane Doe <jane@client.test>", to: MAILBOX, subject: "Trust signing Thursday", snippet: "Can we move it to 10?", at: at(3) });
  google.addMessage({ from: `Alex <${MAILBOX}>`, to: "jane@client.test", subject: "Re: Trust signing Thursday", snippet: "Yes.", at: at(5) });
  google.putEvent({ id: "sign1", updated: new Date(at(6)).toISOString(), summary: "Signing: Rivera trust", start: { dateTime: new Date(at(24 * 60)).toISOString() }, end: { dateTime: new Date(at(25 * 60)).toISOString() }, organizer: { email: MAILBOX }, attendees: [{ email: "jane@client.test" }] });
  clock.now += 16 * 60_000; rt.tick(); await rt.settle();
  await new Promise(r => setTimeout(r, 50)); await host.settle();

  const comms = (await R.query(chain(), "communication", { page: { limit: 50 } })).rows;
  assert.deepEqual(comms.map(c => `${c.data.kind}:${c.data.direction ?? "-"}`).sort(), ["email:inbound", "email:outbound", "meeting:-"]);
  const tl = await timelineOf(host.kernel, chain(), jane.urn);
  assert.equal(tl.length, 3, "two emails and a meeting on Jane's one timeline");
  // seen again on the next look: nothing doubles
  clock.now += 16 * 60_000; rt.tick(); await rt.settle(); await new Promise(r => setTimeout(r, 50)); await host.settle();
  assert.equal((await R.query(chain(), "communication", { page: { limit: 50 } })).rows.length, 3);
  assert.equal((await timelineOf(host.kernel, chain(), jane.urn)).length, 3);
  // the logging read and wrote records and nothing else: no outward call, only reads on the service
  assert.ok(google.calls.every((/** @type {any} */ c) => c.method === "GET"));
  assert.equal(google.sent.length + google.drafts.length, 0);
});
