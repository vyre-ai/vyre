// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  dispatchEvent: () => true,
});
const calls = /** @type {any[]} */ ([]);
function vyred(answers = {}) {
  calls.length = 0;
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body) });
    const a = typeof answers[tool] === "function" ? answers[tool](JSON.parse(o.body)) : answers[tool] ?? {};
    return a && a.$error ? { status: 409, statusText: "", json: async () => ({ error: a.$error }) } : { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
}
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));
const { watcherCard, cardOf, ownerWords } = await import("./watcher.js");

const CARD = { name: "Client follow-ups", hash: "h1", project: "intake", state: "draft", owner: { kind: "project", project: "intake" },
  lines: { when: "Every weekday at 8, before you start.", check: "Whether any client has written since yesterday and not had a reply.", do: "Tell you in chat with the names, and draft a reply for each." },
  facts: { reads: ["inbox (Harlow Legal label)"], readsText: "Your inbox and your client list", credentials: [{ host: "mail.example", item: "mail-harlow", how: "bearer" }], acts: "Drafts only. It never sends.", cost: "About 2 cents a run", schedule: "Weekdays 8:00, your time" }, described: "by its author" };

test("cardOf and ownerWords read the contract; a teammate or a project owns it", () => {
  assert.equal(cardOf(null), null);
  assert.equal(cardOf(CARD).facts.credentials[0].item, "mail-harlow");
  assert.equal(ownerWords({ kind: "project", project: "intake" }), "Owned by the intake project");
  assert.equal(ownerWords({ kind: "teammate", teammate: "kit" }), "Owned by kit");
});

test("the card reads watchers.card, shows When, Check and Then, the facts exactly as given, and the author provenance", async () => {
  vyred({ "watchers.card": CARD });
  const c = watcherCard({ name: "Client follow-ups" });
  await settle();
  assert.deepEqual(calls[0], { tool: "watchers.card", input: { name: "Client follow-ups" } });
  const t = text(c);
  assert.match(t, /Client follow-ups.*Owned by the intake project.*off/);
  assert.match(t, /When.*Every weekday at 8, before you start\./);
  assert.match(t, /Check.*Whether any client has written/);
  assert.match(t, /Then.*Tell you in chat with the names/);
  assert.match(t, /What it will do, as Vyre reads its code/);
  assert.match(t, /Reads.*Your inbox and your client list · inbox \(Harlow Legal label\)/);
  assert.match(t, /Uses.*mail\.example · mail-harlow/);
  assert.match(t, /Acts.*Drafts only\. It never sends\./);
  assert.match(t, /Cost.*About 2 cents a run/);
  assert.match(t, /Runs.*Weekdays 8:00, your time/);
  assert.match(t, /These three sentences are the author's words\. The facts above are what Vyre found in the code\./);
});

test("with no check the last line is Do; described by Vyre says so", async () => {
  vyred({ "watchers.card": { ...CARD, lines: { when: "Every Monday at 9.", do: "List invoices over 30 days old." }, described: "by Vyre" } });
  const c = watcherCard({ name: "Weekly invoice check" });
  await settle();
  assert.match(text(c), /Do.*List invoices over 30 days old/);
  assert.doesNotMatch(text(c), /Check/);
  assert.match(text(c), /Described by Vyre from its code\./);
});

test("Turn on sends watchers.create {name, hash} with the card's own hash, then the card reads On with Turn off; Turn off pauses", async () => {
  vyred({ "watchers.card": CARD, "watchers.create": {}, "watchers.pause": {}, "watchers.resume": {} });
  const c = watcherCard({ name: "Client follow-ups" });
  await settle();
  click($(c, "[data-act=on]")); await settle();
  assert.deepEqual(calls.find(x => x.tool === "watchers.create")?.input, { name: "Client follow-ups", hash: "h1" });
  assert.ok($(c, "[data-act=off]"));
  click($(c, "[data-act=off]")); await settle();
  assert.deepEqual(calls.find(x => x.tool === "watchers.pause")?.input, { name: "Client follow-ups" });
  click($(c, "[data-act=resume]")); await settle();
  assert.deepEqual(calls.find(x => x.tool === "watchers.resume")?.input, { name: "Client follow-ups", hash: "h1" }, "back on carries the hash that was read");
});

test("a changed hash is refused: the card says so, offers Show the new card, and never turns on the other version", async () => {
  let n = 0;
  vyred({ "watchers.card": () => (++n === 1 ? CARD : { ...CARD, hash: "h2", lines: { ...CARD.lines, when: "Every day at 7." } }),
    "watchers.create": { $error: { code: "conflict", message: "Client follow-ups changed after its card was shown" } } });
  const c = watcherCard({ name: "Client follow-ups" });
  await settle();
  click($(c, "[data-act=on]")); await settle();
  assert.match(text(c), /Client follow-ups changed/);
  assert.match(text(c), /code changed since you read it, so it was not turned on/);
  assert.equal(calls.filter(x => x.tool === "watchers.create").length, 1);
  click($(c, "[data-act=reload]")); await settle();
  assert.match(text(c), /Every day at 7\./);
  click($(c, "[data-act=on]")); await settle();
  assert.deepEqual(calls.filter(x => x.tool === "watchers.create")[1].input, { name: "Client follow-ups", hash: "h2" });
});

test("read only (from another source): the card reads, with no buttons; a duty passes its own turnOn", async () => {
  vyred({ "watchers.card": CARD });
  const ro = watcherCard({ name: "x" }, { readOnly: true });
  await settle();
  assert.equal($$(ro, "button").length, 0);
  const seen = [];
  const c = watcherCard({ name: "Client follow-ups" }, { turnOn: async card => { seen.push(card.hash); return { data: {} }; } });
  await settle();
  click($(c, "[data-act=on]")); await settle();
  assert.deepEqual(seen, ["h1"]);
  assert.equal(calls.filter(x => x.tool === "watchers.create").length, 0, "a duty starts through its own call, not watchers.create");
});

test("a watcher whose code changed while paused is not resumed: the card offers the new card", async () => {
  vyred({ "watchers.card": { ...CARD, state: "paused" }, "watchers.resume": { $error: { code: "conflict", message: "Client follow-ups changed after its card was shown" } } });
  const c = watcherCard({ name: "Client follow-ups" });
  await settle();
  click($(c, "[data-act=resume]")); await settle();
  assert.match(text(c), /code changed since you read it, so it was not turned on/);
  assert.ok($(c, "[data-act=reload]"));
});
