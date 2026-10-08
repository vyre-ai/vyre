import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
// Setup steps 8 to 10 in the app: the model over onboard.status and the source over a fake box, ported from the Deck's deck/setup/steps.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { STEPS, setupSteps, viewOf, stepLabel, youInput, historyLines, computersOf, safeHttps, endingOf } from "./model.ts";
import { onboardSource } from "./source.ts";

const status = (over = {}) => ({ person: null, assistant: null, finished: false, steps: { devices: "todo", history: "todo" },
  detail: { devices: { mac: { connected: false, name: null }, macDownload: "https://vyre.run/box/Vyre-Lumen-aarch64.dmg" }, history: { state: "todo", sessions: 0, machines: [] } }, ...over });

test("steps 1 to 7 are done at the address, and 8 to 10 follow the box's record", () => {
  let v = setupSteps(status());
  assert.equal(v.list.map((s) => s.status).join(","), "done,done,done,done,done,done,done,current,todo,todo");
  assert.equal(v.number, 8);
  v = setupSteps(status({ person: "Alex" }));
  assert.equal(v.current, "computers");
  v = setupSteps(status({ person: "Alex", steps: { devices: "skipped", history: "todo" } }));
  assert.equal(v.list[8].status, "skipped");
  assert.equal(v.current, "history");
  v = setupSteps(status({ person: "Alex", steps: { devices: "skipped", history: "skipped" } }));
  assert.equal(v.finished, true);
  assert.equal(setupSteps(status({ person: "  " })).current, "assistant", "a blank name is no name");
  assert.equal(setupSteps(status({ person: "Alex", detail: { devices: { mac: { connected: true } } } })).list[8].status, "done", "a paired Mac is done");
  v = setupSteps(status({ person: "Alex" }), { passed: ["computers", "history"] });
  assert.deepEqual([v.list[8].status, v.list[9].status, v.finished], ["skipped", "done", true], "moving past a step in this visit counts");
});

test("viewOf: the box's own ten steps win, a short or unknown list falls back to onboard.status", () => {
  const ten = STEPS.map((s, i) => ({ id: s.id, title: s.title + "!", where: s.where, optional: s.optional, status: i < 8 ? "done" : i === 8 ? "current" : "todo" }));
  const v = viewOf(status(), { steps: ten, current: "computers" }, []);
  assert.equal(v.list[0].title, "Install!");
  assert.deepEqual([v.current, v.number, v.finished], ["computers", 9, false]);
  assert.equal(viewOf(status(), { steps: ten, current: null, finished: true }, []).finished, true);
  assert.equal(viewOf(status(), { steps: ten.slice(0, 3) }, []).list[0].title, "Install", "three steps is not a list");
  assert.equal(viewOf(status(), { steps: ten.map((s) => ({ ...s, id: "nope" })) }, []).list[0].title, "Install");
  assert.equal(viewOf(status(), null, []).current, "assistant");
  assert.equal(stepLabel(viewOf(status(), null, []), "computers"), "Step 9 of 10, optional");
});

test("the name is asked once; the assistant's name is optional", () => {
  assert.deepEqual(youInput("  ", "x"), { error: "Tell Vyre your name first." });
  assert.deepEqual(youInput(" Alex Rivera ", ""), { name: "Alex Rivera", assistant: undefined });
  assert.deepEqual(youInput("Alex", " Juno "), { name: "Alex", assistant: "Juno" });
});

test("history says what it found, and computers keep only an https download", () => {
  assert.equal(historyLines(status()).found, "Found nothing. There is no Claude Code, Codex or Grok history in the usual folders.");
  const h = historyLines(status({ detail: { history: { sessions: 12, machines: [{ machine: "Alex's Mac", source: "mac", sessions: 12 }, { source: "box", sessions: 0 }] } } }));
  assert.equal(h.found, "Found 12 sessions on Alex's Mac.");
  assert.match(h.hint, /Open Lumen on your Mac/);
  assert.equal(historyLines(status({ detail: { history: { sessions: 1, machines: [] } } })).found, "Found 1 session.");
  assert.equal(computersOf(status()).download, "https://vyre.run/box/Vyre-Lumen-aarch64.dmg");
  assert.equal(computersOf(status({ detail: { devices: { mac: { connected: true, name: null } } } })).mac.name, "Your Mac");
  for (const u of ["http://x.example/a", "javascript:alert(1)", "https://u:p@x.example/", "https://x.example/" + "a".repeat(700), "nonsense", undefined]) assert.equal(safeHttps(u), null, String(u));
});

test("the ending: a thread, no thread, or a reason the assistant could not start", () => {
  assert.deepEqual(endingOf({ assistant: { name: "juno", display: "Juno", thread: "t1" } }), { name: "juno", display: "Juno", thread: "t1" });
  assert.deepEqual(endingOf(null), { name: null, display: null, thread: null });
  assert.deepEqual(endingOf({ state: "failed", display: "Juno", why: "no Claude yet" }), { name: null, display: "Juno", thread: null, why: "no Claude yet" });
  assert.equal(endingOf({ state: "failed" }).why, "it could not be made");
});

/** A fake box that records every call. */
function box(handlers) {
  const calls = [];
  const call = async (tool, input) => {
    calls.push([tool, input]);
    const h = handlers[tool];
    if (!h) return { error: { code: "no_such_tool", message: "no tool " + tool } };
    try { return { data: await h(input) }; } catch (e) { return { error: { code: "bad", message: e.message } }; }
  };
  return { call, calls };
}

test("source: read takes the box's step list when it has onboard.setup, and null when it has not", async () => {
  let b = box({ "onboard.status": () => status(), "onboard.setup": () => ({ current: "history" }) });
  assert.equal((await onboardSource(b.call).read()).setup.current, "history");
  b = box({ "onboard.status": () => status() });
  const r = await onboardSource(b.call).read();
  assert.equal(r.setup, null);
  assert.equal(r.status.person, null);
  b = box({});
  await assert.rejects(onboardSource(b.call).read(), /no tool onboard.status/);
});

test("source: you, skip and history send what the Deck sent", async () => {
  const b = box({ "onboard.you": () => ({}), "onboard.skip": () => ({}), "onboard.setup": () => ({}), "onboard.history": () => ({}) });
  const s = onboardSource(b.call);
  await s.you("Alex", "Juno"); await s.you("Alex");
  await s.skip("computers", false); await s.skip("history", false); await s.skip("computers", true);
  await s.history(true); await s.history(false);
  assert.deepEqual(b.calls, [
    ["onboard.you", { name: "Alex", assistant: "Juno" }], ["onboard.you", { name: "Alex" }],
    ["onboard.skip", { step: "devices" }], ["onboard.skip", { step: "history" }], ["onboard.setup", { skip: "computers" }],
    ["onboard.history", { action: "start" }], ["onboard.setup", { pass: "history" }], ["onboard.history", { action: "start" }],
  ]);
});

test("source: history still passes when the scan call is refused, and a refused name says why", async () => {
  const b = box({ "onboard.you": () => { throw new Error("name too long"); } });
  await onboardSource(b.call).history(false);
  await assert.rejects(onboardSource(b.call).you("A"), /name too long/);
});

test("source: finish and retry end with the assistant, and retry falls back to finish on a box without onboard.assistant", async () => {
  let b = box({ "onboard.finish": () => ({ assistant: { name: "juno", display: "Juno", thread: "t9" } }) });
  assert.equal((await onboardSource(b.call).finish()).thread, "t9");
  assert.equal((await onboardSource(b.call).retry()).thread, "t9");
  assert.deepEqual(b.calls.map((c) => c[0]), ["onboard.finish", "onboard.assistant", "onboard.finish"]);
  b = box({ "onboard.assistant": (i) => (i.retry ? { name: "juno", display: "Juno", made: false, why: "Claude is not signed in", state: "failed" } : {}) });
  assert.equal((await onboardSource(b.call).retry()).why, "Claude is not signed in");
});
