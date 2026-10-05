// @ts-check
import "../../../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMockStore, REVEAL_MS } from "./mock-store.js";
import { getStore, setStore } from "./store.js";
import { needsYou, needsReason, cardTitle } from "./tasks.js";
import { runClientPays } from "./scenario.js";
import { aliasUrn, seeded, SPACE, WHO } from "./mock-ids.js";
import { simulatedProof } from "./kernel-view.js";
import { ref } from "./mock-values.js";

const NOON = Date.parse("2026-10-01T13:00:00");
const METHODS = ["spaces", "actors", "types", "list", "get", "create", "update", "putSealed", "reveal", "seesAs", "tasks", "task", "request", "decide", "submit", "move", "reassign", "editTask",
  "events", "define", "subscribe", "me", "calendar"];
/** The id the seeded task k<n> has. @param {number} n */
const K = n => seeded(`k${n}`);
const proof = (/** @type {string} */ decision, now = NOON) => simulatedProof({ decision, now });
const what = (/** @type {any} */ e) => String(e.data.what);
/** @param {any} err @param {string} code */
const code = c => (/** @type {any} */ err) => err?.code === c;

test("the mock store implements the whole Store interface", async () => {
  const s = createMockStore({ now: () => NOON });
  for (const m of METHODS) assert.equal(typeof /** @type {any} */ (s)[m], "function", m);
  assert.deepEqual((await s.spaces()).map(x => x.name), ["Mine", "Harlow Legal"]);
  assert.deepEqual((await s.actors()).map(a => a.name), ["Alex Rivera", "Chris Park", "juno", "kit", "iris", "rev", "Research", "Intake", "Drafting", "Vyre"]);
  const types = await s.types();
  assert.ok(["contact", "matter", "project", "trip", "template"].every(n => types.some(t => t.name === n)));
  assert.deepEqual((await s.types(SPACE.mine)).map(t => t.name).sort(), ["project", "trip"]);
  const doe = (await s.list("matter")).find(m => m.data.title === "Doe estate plan");
  assert.equal(doe?.data.stage, "Engagement");
  assert.equal(doe?.urn, aliasUrn("m1"));
  assert.equal(doe?.version, 1);
  assert.equal((await s.list("contact", { space: SPACE.harlow })).some(c => c.data.name === "Jane Doe"), true);
  assert.equal((await s.list("matter", { filter: { field: "stage", op: "eq", value: "Signing" } })).length, 1);
  assert.equal(await s.get("vyre://spc_harlowaaaaaa/matter/nope"), null);
  assert.equal(await s.task("nope"), null);
});

test("the morning world holds k1 to k28, and seven things need Alex", async () => {
  const s = createMockStore({ now: () => NOON });
  const all = await s.tasks();
  assert.equal(all.length, 28);
  assert.equal(all[0].id, K(1));
  const actors = await s.actors();
  const alias = (/** @type {string} */ id) => `k${[...Array(28).keys()].find(i => K(i + 1) === id) + 1}`;
  const mine = all.filter(t => needsYou(t, WHO.alex, actors));
  assert.deepEqual(mine.map(t => alias(t.id)), ["k4", "k6", "k9", "k10", "k13", "k22", "k28"]);
  assert.deepEqual(mine.map(t => needsReason(t, WHO.alex, actors)), ["do", "stuck", "do", "do", "check", "do", "check"]);
  const inMine = await s.tasks({ space: SPACE.mine });
  assert.ok(inMine.length > 0 && inMine.every(t => t.space === SPACE.mine && String(t.record).startsWith(`vyre://${SPACE.mine}/`)));
  assert.equal((await s.tasks({ state: ["stuck"] })).length, 2);
  assert.equal((await s.tasks({ checker: WHO.alex, state: ["needs_check"] })).length, 2);
  assert.equal((await s.events({ limit: 3 })).length, 3);
});

test("a sealed field is never in a read; an assistant's view never holds it; Reveal gives it for 30 seconds", async () => {
  let t = NOON;
  const s = createMockStore({ now: () => t });
  const c1 = aliasUrn("c1");
  const jane = await s.get(c1);
  // A sealed value reads as a SealedRefValue: a reference and facts about it, never the value.
  const held = /** @type {any} */ (jane?.data.ssn);
  assert.equal(typeof held.ref, "string");
  assert.equal(held.sealed, "us-ssn");
  assert.equal(held.present, true);
  assert.equal(held.value, undefined);
  assert.equal(JSON.stringify(await s.list("contact")).includes("412-55-6789"), false);
  assert.equal(JSON.stringify(s.snapshot()).includes("412-55-6789"), false, "no record, task, event or type in the store holds the plaintext");

  // An assistant reads a placeholder: no ref, so nothing to reveal.
  const asAssistant = await s.seesAs(c1, "assistant");
  assert.equal(JSON.stringify(asAssistant).includes("412-55-6789"), false);
  const placeholder = /** @type {any} */ (asAssistant.ssn);
  assert.equal(placeholder.ref, undefined);
  assert.equal(placeholder.present, true);
  assert.equal(asAssistant.name, "Jane Doe");
  assert.equal(/** @type {any} */ ((await s.seesAs(c1, "person")).ssn).ref, held.ref);

  // Reveal wants a presence proof, a sealed field, and gives the value for 30 seconds, written down without the value.
  await assert.rejects(() => s.reveal(c1, "ssn", "Prepare the engagement letter", /** @type {any} */ ({ signer: "none" })), /Face ID/);
  await assert.rejects(() => s.reveal(c1, "name", "why", proof("reveal")), /not sealed/);
  const r = await s.reveal(c1, "ssn", "Prepare the engagement letter", proof("reveal"));
  assert.equal(r.value, "412-55-6789");
  assert.equal(r.expires_in_ms, REVEAL_MS);
  assert.equal(REVEAL_MS, 30_000);
  const ev = (await s.events({ record: c1 })).find(e => /revealed .* on Jane Doe for 30 seconds/.test(what(e)));
  assert.ok(ev, "the reveal is in the timeline");
  assert.equal(JSON.stringify(ev).includes("412-55-6789"), false);

  // A sealed value never goes through a record update; only a person seals one; a stale version is refused.
  await assert.rejects(() => s.update(c1, { ssn: "000-00-0000" }, jane?.version || 0, WHO.alex), code("sealed_value_refused"));
  await assert.rejects(() => s.putSealed(c1, "ssn", "000-00-0000", WHO.juno), code("sealed_value_refused"));
  await assert.rejects(() => s.putSealed(c1, "name", "x", WHO.alex), code("invalid"));
  const sealedNow = await s.putSealed(c1, "ssn", "412-55-0000", WHO.alex);
  assert.equal(JSON.stringify(sealedNow).includes("412-55-0000"), false);
  assert.equal(sealedNow.version, (jane?.version || 0) + 1);
  assert.equal((await s.reveal(c1, "ssn", "again", proof("reveal"))).value, "412-55-0000");
  await assert.rejects(() => s.update(c1, { notes: "x" }, jane?.version || 0, WHO.alex), code("version_conflict"));
  t += 1;
});

test("subscribe calls back after any change and stops when told to", async () => {
  const s = createMockStore({ now: () => NOON });
  const c1 = aliasUrn("c1");
  let n = 0;
  const off = s.subscribe(() => { n++; });
  await s.update(c1, { notes: "x" }, 1);
  assert.equal(n, 1);
  await s.reassign(K(6), WHO.chris);
  assert.equal(n, 2);
  off();
  await s.update(c1, { notes: "y" }, 2);
  assert.equal(n, 2);
});

test("a stuck task is reassigned and starts again; only people and assistants take tasks", async () => {
  const s = createMockStore({ now: () => NOON });
  const k = await s.reassign(K(6), WHO.chris);
  assert.deepEqual([aidOf(k.doer), k.state, k.stuck], [WHO.chris, "ready", undefined]);
  await assert.rejects(() => s.reassign(K(6), WHO.vyre), /not someone/);
  await assert.rejects(() => s.reassign(K(1), WHO.chris), /finished/);
});

/** @param {any} a */
function aidOf(a) { return a?.id; }

test("an assistant cannot mark a task done without its output, and cannot touch someone else's task", async () => {
  const s = createMockStore({ world: "payday", now: () => NOON });
  const ran = await runClientPays(s, {});
  const tasks = await s.tasks({ record: ran.matter });
  assert.equal(tasks.find(t => aidOf(t.doer) === "research")?.state, "done");

  const s2 = createMockStore({ world: "empty", now: () => NOON });
  const jane = await s2.create("contact", { name: "Jane Doe", role: "Client" }, { by: WHO.vyre });
  const m = await s2.create("matter", { title: "Doe estate plan", client: ref(jane.urn) }, { by: WHO.vyre });
  const r = (await s2.tasks({ record: m.urn })).find(t => aidOf(t.doer) === "research");
  assert.ok(r);
  assert.equal(r.state, "working", "an assistant's task starts by itself");
  // Output first: handing in nothing is refused, and the task stays where it was.
  await assert.rejects(() => s2.submit(r.id, {}, "research"), /./);
  assert.equal((await s2.task(r.id))?.state, "working");
  // Vyre, not the assistant, moves a task to done: the table has no move for the doer.
  await assert.rejects(() => s2.move(r.id, "done", "research"), /Vyre moves this once the output is checked/);
  // Someone else's assistant cannot touch it, nor can it be moved by an outsider.
  await assert.rejects(() => s2.submit(r.id, { note: { text: "x", sources: ["y"] } }, "juno"), /Only the doer, the checker or the doer's owner/);
  await assert.rejects(() => s2.move(r.id, "stuck", "juno", { reason: "x" }), /Only the doer, the checker or the doer's owner/);
  assert.equal((await s2.task(r.id))?.state, "working");
});

test("approving a task records an event and sends nothing", async () => {
  const s = createMockStore({ now: () => NOON });
  const before = (await s.events({})).length;
  const k = await s.decide(K(13), { outcome: "approved", proof: proof("approve") });
  assert.equal(k.state, "done");
  assert.equal(k.outcome, "approved");
  assert.equal(/** @type {any} */ (k.payload).decision, "approve");
  const ev = await s.events({ task: K(13) });
  assert.equal(ev.length, 1);
  assert.match(what(ev[0]), /approved and sent Email to Dana Reyes/);
  assert.match(String(ev[0].data.why), /Face ID/);
  assert.equal((await s.events({})).length, before + 1);
  await assert.rejects(() => s.decide(K(13), { outcome: "approved", proof: proof("approve") }), /Nothing is waiting/);
  await assert.rejects(() => s.decide(K(4), { outcome: "approved", proof: proof("approve") }), /Nothing is waiting/);
  // Approval is the checker's, with a presence proof.
  await assert.rejects(() => s.decide(K(28), { outcome: "approved", proof: /** @type {any} */ ({ signer: "none" }) }), /Face ID/);
  assert.equal((await s.task(K(28)))?.state, "needs_check");
  const chris = createMockStore({ me: "chris", now: () => NOON });
  await assert.rejects(() => chris.decide(K(13), { outcome: "approved", proof: proof("approve") }), /Only the checker/);
  assert.equal((await chris.task(K(13)))?.state, "needs_check");
});

test("a task sent back goes to ready with the checker's reason, and its assistant starts it again", async () => {
  const s = createMockStore({ now: () => NOON });
  const k = await s.decide(K(13), { outcome: "rejected", reason: "Say it shorter", proof: proof("reject") });
  assert.equal(k.state, "working", "kit is an assistant: ready, then it starts itself");
  assert.deepEqual(s.transitions().filter(m => m.task === K(13)).map(m => [m.from, m.to]), [["needs_check", "ready"], ["ready", "working"]]);
  assert.equal(k.outcome, "rejected");
  assert.deepEqual(k.answer, { reason: "Say it shorter" });
});

test("request puts a task on a record, waiting on what it depends on", async () => {
  const s = createMockStore({ now: () => NOON });
  const m1 = aliasUrn("m1");
  const t = await s.request({ title: "Call Jane", record: m1, doer: WHO.alex, output: { kind: "decision" }, depends_on: [K(3)] });
  assert.equal(t.state, "waiting");
  assert.equal(aidOf(t.doer), WHO.alex);
  const free = await s.request({ title: "Ring Chris", record: m1, doer: WHO.juno, output: { kind: "note" } });
  assert.equal(free.state, "working", "an assistant's ready task starts by itself");
  await assert.rejects(() => s.request({ title: "x", record: "vyre://spc_harlowaaaaaa/matter/zz", doer: WHO.alex, output: { kind: "file" } }), /does not exist/);
});

test("getStore is the one switch, and setStore replaces it", async () => {
  setStore(null);
  const a = getStore();
  assert.equal(getStore(), a);
  const mine = createMockStore({ world: "empty" });
  setStore(mine);
  assert.equal(getStore(), mine);
  setStore(null);
  assert.notEqual(getStore(), mine);
  setStore(null);
});

test("client pays: Now's Needs-you holds exactly one card, and approving it moves the stage on by itself", async () => {
  const s = createMockStore({ world: "empty", now: () => NOON });
  const steps = /** @type {number[]} */ ([]);
  const ran = await runClientPays(s, { onStep: n => steps.push(n) });
  assert.deepEqual(steps, [1, 2, 3, 4]);

  const actors = await s.actors();
  const matter = await s.get(ran.matter);
  assert.equal(matter?.data.title, "Doe estate plan");
  assert.equal(matter?.data.stage, "Intake");
  // Created from the Kit, with its team's tasks, and Research's findings written onto the record, with sources.
  assert.deepEqual((await s.tasks({ record: ran.matter })).map(t => [aidOf(t.doer), t.state]), [["research", "done"], ["intake", "needs_check"]]);
  assert.match(String(matter?.data.research), /Sources: Intake form, 8 Sep, County property record/);
  assert.ok(matter?.data.situation && matter?.data.assets && matter?.data.pressure);
  const research = (await s.tasks({ record: ran.matter }))[0];
  assert.equal(research.ext?.result?.note?.sources.length, 3);

  // Now: one card for the person.
  const cards = (await s.tasks()).filter(t => needsYou(t, WHO.alex, actors));
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(cardTitle(card, needsReason(card, WHO.alex, actors), actors), "Welcome email for Jane Doe is ready");
  assert.equal(card.state, "needs_check");
  assert.equal(aidOf(card.doer), "intake");
  assert.equal(aidOf(card.checker), WHO.alex);
  assert.match(String(card.ext?.result?.draft?.body), /^Hi Jane,/);
  assert.match(String(card.ext?.result?.draft?.body), /Your matter is Doe estate plan, and Alex Rivera is your attorney/);

  // One tap: the checker's approval is the Gate approval. The stage moves on by itself.
  await s.decide(card.id, { outcome: "approved", proof: proof("approve") });
  assert.equal((await s.get(ran.matter))?.data.stage, "Engagement");
  const after = await s.tasks({ record: ran.matter });
  assert.deepEqual(after.map(t => [t.title, t.state]), [["Research the client", "done"], ["Welcome email for Jane Doe", "done"], ["Engagement letter", "working"], ["Review the draft with Jane Doe", "waiting"]]);
  assert.equal((await s.tasks()).filter(t => needsYou(t, WHO.alex, actors)).length, 0, "nothing needs Alex until the engagement letter is drafted");
  assert.ok((await s.events({ record: ran.matter })).some(e => /moved Doe estate plan to Engagement by itself/.test(what(e))));
  // Every move the run made went through the table: none was made by the wrong party.
  const bad = s.transitions().filter(m => m.to === "done" && m.by !== "kernel" && m.by !== WHO.alex);
  assert.deepEqual(bad, []);
});

test("client pays: it runs on a world that already holds other work, next to it", async () => {
  const s = createMockStore({ world: "payday", now: () => NOON });
  const actors = await s.actors();
  const before = (await s.tasks()).filter(t => needsYou(t, WHO.alex, actors)).length;
  await runClientPays(s, {});
  assert.equal((await s.tasks()).filter(t => needsYou(t, WHO.alex, actors)).length, before + 1);
  assert.equal((await s.list("contact")).filter(c => c.data.name === "Jane Doe").length, 1, "the existing contact is reused");
});
