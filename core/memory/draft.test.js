// @ts-check
// memory.ask's draft (plan 3.7): the answer so far goes to the calling connection only, at least 100 ms
// apart, and is taken back (an empty draft) when the check fails. It never rides the events bus.
// Fictional data only (Northwind Bakery).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import { partialAnswer, drafter } from "./iq/ask.js";
import memory from "./index.js";

const Q = "when does the Northwind watcher post the weekly invoice total?";
const NW = SESSIONS.find(x => x.turns.some(u => /weekly total on Fridays/.test(u.text)));
const HIT = { session: NW.id, seq: NW.turns.findIndex(u => /every Friday at 5pm/.test(u.text)), role: "assistant", ts: NW.start, name: "Northwind invoices", cwd: NW.cwd,
  text: "Added: every Friday at 5pm the watcher posts the week's invoice total for Northwind Bakery." };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("draft: the answer so far is read out of a JSON reply still arriving", () => {
  assert.equal(partialAnswer('{"ans'), null);
  assert.equal(partialAnswer('{"answer": "Port 84'), "Port 84");
  assert.equal(partialAnswer('{"answer": "She said \\"yes'), 'She said "yes');
  assert.equal(partialAnswer('{"answer": "a\\'), "a");
  assert.equal(partialAnswer('{"answer": "Done", "cite": [1]}'), "Done");
});

test("draft: at most one update every 100 ms, whole text so far", async () => {
  const got = [];
  const on = drafter(t => got.push(t), () => {});
  on('{"answer": "Po'); on('{"answer": "Port'); await sleep(120); on('{"answer": "Port 8443'); on('{"answer": "Port 8443."');
  assert.deepEqual(got, ["Po", "Port 8443"]);
});

async function module_(t, reply) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map(), bus = [];
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: (type, payload) => bus.push({ type, payload }), since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "recall.search" ? { data: [HIT] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: [], projects: [] }),
    tool: (name, def) => tools.set(name, def),
    // A streaming model: the reply arrives in pieces, 120 ms apart.
    iqRunner: async ({ onText }) => {
      let soFar = "";
      for (const piece of reply.match(/.{1,14}/g) || []) { soFar += piece; if (onText) onText(soFar); await sleep(120); }
      return { text: reply, usd: 0 };
    },
    memoryRunner: null,
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  await tools.get("memory.curate").run({}, { caller: "cli" });
  return { ask: (input, extra) => tools.get("memory.ask").run(input, { caller: "cli", ...extra }), bus };
}

test("draft: a failed check takes the draft back, and no draft text ever reaches the events bus", async t => {
  const reply = JSON.stringify({ answer: "The Northwind watcher posts the invoice total every Monday at 9000 hours", cite: [1], confidence: 0.9, abstain: false, known: [] });
  const { ask, bus } = await module_(t, reply);
  const drafts = [];
  const r = await ask({ question: Q, stream: true, id: "cap_9" }, { draft: d => drafts.push(d) });
  assert.equal(r.abstained, true, "that time is in no passage, so the check refuses it");
  assert.ok(drafts.length >= 2, JSON.stringify({ drafts, r }));
  assert.ok(drafts.every(d => d.id === "cap_9"));
  assert.match(drafts[0].text, /^The/);
  assert.ok(drafts[1].text.startsWith(drafts[0].text) && drafts[1].text.length > drafts[0].text.length, "each draft is the whole text so far");
  assert.equal(drafts[drafts.length - 1].text, "", "the draft is removed");
  assert.doesNotMatch(JSON.stringify(bus), /Northwind watcher posts|9000/, "draft text is on the connection, not the bus");
  assert.ok(bus.some(e => e.type === "memory.thinking"), "stage events still ride the bus");
});

test("draft: a caller that did not ask for one gets none, and neither does a not-streamed ask", async t => {
  const reply = JSON.stringify({ answer: "The Northwind watcher posts the total on port 9000", cite: [1], confidence: 0.9, abstain: false, known: [] });
  const { ask, bus } = await module_(t, reply);
  const drafts = [];
  await ask({ question: Q, stream: true }, {});
  assert.equal(bus.filter(e => e.type === "memory.draft").length, 0);
  await ask({ question: Q }, { draft: d => drafts.push(d) });
  assert.equal(drafts.length, 0, "no stream: true, no draft");
  assert.doesNotMatch(JSON.stringify(bus), /Northwind watcher posts/);
});
