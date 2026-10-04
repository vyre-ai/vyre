// @ts-check
// deck/chat/core/provider-caps.js: controls read the provider's LIVE caps; the thread's snapshot
// only renders the past (reviewer-2 M1). A missing flag hides or explains, never offers.

import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { liveCaps, snapshotCaps, controls, meter, HIDE } from "./provider-caps.js";

const providers = [
  { provider: "claude", label: "Claude", caps: { steer: true, queue: true, interrupt: true, resume: true, fork: true,
    rewind: { conversation: true, code: true }, modes: ["default", "acceptEdits", "plan"], plan: true, questions: true,
    permissions: true, thinking: true, effort: true, images: true, commands: true, tasks: true, subagents: true,
    model_switch: true, usage: "detailed", remember: "CLAUDE.md" } },
  { provider: "codex", label: "ChatGPT", caps: { interrupt: true, resume: true, images: true, usage: "coarse", remember: "AGENTS.md" } },
];

test("live caps come from providers.list; an unknown provider offers nothing", () => {
  assert.equal(liveCaps(providers, "claude").rewind.code, true);
  assert.equal(liveCaps(providers, "codex").steer, false);
  const gone = liveCaps(providers, "removed");
  assert.equal(gone.interrupt, false);
  assert.equal(controls(gone, "Grok").interrupt.state, "off");
});

test("the snapshot renders the past but never drives a control", () => {
  // The thread ran when this provider could rewind; the adapter dropped it since.
  const thread = { provider: "codex", caps: { rewind: { conversation: true, code: false } } };
  assert.equal(snapshotCaps(thread).rewind.conversation, true, "the past says what it ran with");
  const now = controls(liveCaps(providers, thread.provider), "ChatGPT");
  assert.equal(now.rewind.state, "off", "the button follows what the provider can do now");
  assert.equal(now.rewind.reason, "ChatGPT can't rewind a conversation yet");
});

test("a lacking control either hides (expected absence) or explains in plain words", () => {
  const c = controls(liveCaps(providers, "codex"), "ChatGPT");
  assert.equal(c.modes.state, "hidden", "no mode chip at all");
  assert.equal(c.thinking.state, "hidden");
  assert.equal(c.steer.state, "off");
  assert.equal(c.steer.reason, "ChatGPT reads a new message after the current turn ends");
  assert.equal(c.modelSwitch.reason, "ChatGPT keeps its model for the whole session");
  assert.equal(c.images.state, "on");
  assert.equal(c.remember.state, "on");
  for (const [name, ctl] of Object.entries(c)) {
    if (ctl.state === "off") assert.ok(ctl.reason && !/undefined|null/.test(ctl.reason) && !/—/.test(ctl.reason), name);
    if (ctl.state === "hidden") assert.ok(HIDE.has(name), name);
  }
  const all = controls(liveCaps(providers, "claude"), "Claude");
  assert.ok(Object.values(all).every(x => x.state === "on"), "Claude declares everything");
});

test("the meter shows what usage allows: everything, context only, or nothing (never zeros)", () => {
  assert.equal(meter(liveCaps(providers, "claude")), "full");
  assert.equal(meter(liveCaps(providers, "codex")), "context");
  assert.equal(meter(liveCaps([], "x")), null);
});

test("providers.list's real rows ({ id, capabilities }) read the same as the earlier draft's ({ provider, caps })", () => {
  const real = [{ id: "codex", label: "Codex", accounts: [], models: [], capabilities: { streaming: true, resume: true, interrupt: true, modes: false, steering: false, usage: "coarse", rewind: false } }];
  const c = liveCaps(real, "codex");
  assert.equal(c.interrupt, true);
  assert.equal(c.resume, true);
  assert.equal(liveCaps(real, "claude").interrupt, false);
});
