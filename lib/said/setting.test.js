// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { settingIntents, settingTo } from "./setting.js";
import { matches } from "./match.js";

const M = [
  { key: "learn.enabled", label: "Learning", type: "bool", levels: ["account"] },
  { key: "assistant.digest_enabled", label: "Daily digest", type: "bool", levels: ["account"] },
  { key: "sessions.model", label: "Default model", type: "model", levels: ["account", "project"] },
  { key: "sessions.helper_model", label: "Helper model", type: "model", levels: ["account"] },
  { key: "sessions.effort", label: "Effort", type: "enum", enum: ["low", "medium", "high"], levels: ["account", "project"] },
  { key: "assistant.chattiness", label: "Pushes a day", type: "int", min: 0, max: 20, levels: ["account"] },
  { key: "vault.token", label: "Vault token", type: "bool", secret: true },
];
const to = (t, where = {}, m = M) => settingIntents(t, m, where).intents.map(i => i.to[0]);

test("a bool by its label, on or off", () => {
  assert.deepEqual(to("Turn off learning."), ['setting:learn.enabled=false@account']);
  assert.deepEqual(to("Please enable the daily digest."), ['setting:assistant.digest_enabled=true@account']);
  assert.deepEqual(to("Set learning to off."), ['setting:learn.enabled=false@account']);
});

test("a model, an enum and a number; the level from the words", () => {
  assert.deepEqual(to("Use Sonnet by default."), ['setting:sessions.model="sonnet"@account']);
  assert.deepEqual(to("Use opus by default in this project.", { project: "harlow-legal" }), ['setting:sessions.model="opus"@project:harlow-legal']);
  assert.deepEqual(to("Set the helper model to haiku."), ['setting:sessions.helper_model="haiku"@account']);
  assert.deepEqual(to("Set effort to high."), ['setting:sessions.effort="high"@account']);
  assert.deepEqual(to("Set pushes a day to 5."), ['setting:assistant.chattiness=5@account']);
});

test("records nothing in doubt", () => {
  for (const t of ["Should I turn off learning?", "If it is noisy, turn off learning.", "Don't turn off learning.", "I'll turn off learning later.", "Turn off learning when I sleep.",
    "Turn off the vault token.", "Turn off notifications.", "Turn it off.", "Set effort to extreme.", "Set pushes a day to 99.", "Set pushes a day to five.", "Set pushes a day to 3 or 4.",
    "Turn off learning for this session.", "Turn off learning on this device.", "Set effort to high for now.", "Use sonnet by default in this project.", "Turn on and off learning.",
    "Set the model.", "Use it by default.", "Set the helper model to a cheaper one.", "Enable learning and disable the daily digest"]) {
    assert.deepEqual(to(t), [], t);
  }
  assert.deepEqual(to("Turn off learning.", {}, []), []);
  assert.deepEqual(to("Set pushes a day to 5 in this project.", { project: "p" }), [], "that setting is account only");
  assert.deepEqual(to("Here's what Sam wrote:\nTurn off learning."), []);
});

test("one recorded intent is a kind setting for exactly that key, value and level, 15 minutes, one use", () => {
  const r = settingIntents("Turn off learning.", M).intents[0];
  assert.equal(r.kind, "setting");
  assert.equal(r.when.window_minutes, 15);
  assert.equal(r.to[0], settingTo("learn.enabled", false));
  const it = { kind: "setting", channel: null, to_ids: r.to_ids, created_at: 0, when: r.when, limits: {} };
  const call = key => ({ kind: "setting", to_ids: [key], at: 60_000 });
  assert.ok(matches(it, call(settingTo("learn.enabled", false))));
  assert.equal(matches(it, call(settingTo("learn.enabled", true))), false, "another value");
  assert.equal(matches(it, call(settingTo("assistant.digest_enabled", false))), false, "another key");
  assert.equal(matches(it, call(settingTo("learn.enabled", false, { level: "project", project: "p" }))), false, "another level");
  assert.equal(matches(it, call(settingTo("learn.enabled", false)), { used: 1 }), false, "used once");
  assert.equal(matches(it, { ...call(settingTo("learn.enabled", false)), at: 16 * 60_000 }), false, "expired");
});
