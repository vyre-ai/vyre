// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";
import { STEPS, setupSteps } from "./steps.js";
import { STEPS as PAGE_STEPS } from "../../site/setup/flow.js";

const status = (over = {}) => ({ person: null, assistant: null, finished: false, steps: { devices: "todo", history: "todo" },
  detail: { devices: { mac: { connected: false, name: null }, macDownload: "https://vyre.run/box/Vyre-Lumen-aarch64.dmg" }, history: { state: "todo", sessions: 0, machines: [] } }, ...over });
const until = async (f, ms = 2000) => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 5)); } };

test("the address's step list is the setup page's step list", () => {
  assert.deepEqual(STEPS, PAGE_STEPS);
});

test("steps 1 to 7 are done at the address, and 8 to 10 follow the server's record", () => {
  let v = setupSteps(status());
  assert.deepEqual(v.list.map(s => s.status).join(","), "done,done,done,done,done,done,done,current,todo,todo");
  assert.equal(v.number, 8);
  v = setupSteps(status({ person: "Alex" }));
  assert.equal(v.current, "computers");
  v = setupSteps(status({ person: "Alex", steps: { devices: "skipped", history: "todo" } }));
  assert.equal(v.list[8].status, "skipped");
  assert.equal(v.current, "history");
  v = setupSteps(status({ person: "Alex", steps: { devices: "skipped", history: "skipped" } }));
  assert.equal(v.finished, true);
  assert.equal(setupSteps(status({ person: "  " })).current, "assistant", "a blank name is no name");
});

test("mount: the name is asked once, then computers, then history, then the finish with the assistant", async () => {
  const dom = install();
  const { mountSetup } = await import("./mount.js");
  const host = dom.createElement("div");
  let st = status();
  const calls = [];
  const call = async (tool, input) => {
    calls.push([tool, input]);
    if (tool === "onboard.status") return st;
    if (tool === "onboard.you") { st = { ...st, person: input.name, assistant: input.assistant || null }; return st; }
    if (tool === "onboard.skip") { st = { ...st, steps: { ...st.steps, devices: "skipped" } }; return st; }
    if (tool === "onboard.history") return st;
    if (tool === "onboard.finish") { st = { ...st, finished: true }; return { ...st, assistant: { name: "juno", display: "Juno", thread: null } }; }
    throw new Error("no such tool " + tool);
  };
  const m = mountSetup(host, { call, pollMs: 5 });
  await until(() => text(host).includes("You and your assistant"));
  assert.ok(text(host).includes("Step 8 of 10"));
  const click = el => el.listeners.get("click")[0]({});
  const btn = label => $$(host, "button").find(b => text(b) === label);
  click(btn("Continue"));
  assert.ok(text(host).includes("Tell Vyre your name first."), "no name, no step");
  const you = $(host, "input[name=you]");
  you.value = "Alex Rivera";
  you.listeners.get("input")[0]({});
  click(btn("Continue"));
  await until(() => text(host).includes("Pair a Mac or a Windows PC"));
  assert.deepEqual(calls.find(c => c[0] === "onboard.you")[1], { name: "Alex Rivera", assistant: undefined });
  click(btn("Skip for now"));
  await until(() => text(host).includes("Found nothing"));
  assert.ok(text(host).includes("no Claude Code, Codex or Grok history"), "a step with nothing to show says so");
  click(btn("Continue"));
  await until(() => text(host).includes("Juno is ready when you are"));
  assert.ok(calls.some(c => c[0] === "onboard.finish"));
  m.stop();
});

test("mount: a failed assistant says why and Try again asks the server again", async () => {
  const dom = install();
  const { mountSetup } = await import("./mount.js");
  const host = dom.createElement("div");
  const st = status({ person: "Alex", steps: { devices: "skipped", history: "skipped" } });
  let tries = 0;
  const call = async tool => {
    if (tool === "onboard.status") return st;
    if (tool === "onboard.finish") return { assistant: { name: null, display: "Juno", thread: null, why: "no AI is signed in yet" } };
    if (tool === "onboard.assistant") { tries++; return { name: "juno", display: "Juno", thread: "t1" }; }
    throw new Error("no such tool");
  };
  const opened = [];
  const m = mountSetup(host, { call, pollMs: 5, onOpenThread: t => opened.push(t) });
  await until(() => text(host).includes("no AI is signed in yet"));
  $$(host, "button").find(b => text(b) === "Try again").listeners.get("click")[0]({});
  await until(() => text(host).includes("Open Juno's thread"));
  assert.equal(tries, 1);
  $$(host, "button").find(b => text(b).startsWith("Open Juno")).listeners.get("click")[0]({});
  assert.deepEqual(opened, ["t1"]);
  m.stop();
});

test("mount: the same ten steps are drawn as a rail and a bar, and nothing is written as markup", async () => {
  const dom = install();
  const { mountSetup } = await import("./mount.js");
  const host = dom.createElement("div");
  const m = mountSetup(host, { call: async () => status({ person: "Alex" }), pollMs: 50 });
  await until(() => $(host, ".tl-rail"));
  assert.equal($$($(host, ".tl-rail"), "li.tl-step").length, 10);
  assert.equal($$($(host, ".tl-list"), "li.tl-step").length, 10);
  m.stop();
});
