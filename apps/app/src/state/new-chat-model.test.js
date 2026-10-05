import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { agentChoices, defaultAccount, isProjectRecordId, slugFromRef, startInput, threadIdOf } from "./new-chat-model.js";

test("the assistant is first and the default", () => {
  const c = agentChoices([{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }, { bad: 1 }]);
  assert.deepEqual(c.map((a) => a.name), ["juno", "kit"]);
  assert.equal(c[0].assistant, true);
  assert.deepEqual(agentChoices(null), []);
});

test("the account is the default signed-in one", () => {
  assert.equal(defaultAccount([{ id: "claude", accounts: [{ id: "a1", signed_in: true }, { id: "a2", signed_in: true, default: true }] }]), "a2");
  assert.equal(defaultAccount([{ id: "claude", accounts: [{ id: "a1", signed_in: false }] }]), null);
  assert.equal(defaultAccount(undefined), null);
});

test("threads.start names the agent, its kind and the account, and starts in a folder", () => {
  const r = startInput({ agent: { name: "juno", kind: "assistant" }, account: "a2", text: " hello ", root: "/srv/files", surface: "web" });
  assert.deepEqual(r, { input: { surface: "web", cwd: "/srv/files", prompt: "hello", agent: "juno", agent_kind: "assistant", account: "a2" } });
  assert.deepEqual(startInput({ agent: null, account: null, text: "", root: "/r", surface: "mobile" }), { input: { surface: "mobile", cwd: "/r" } });
  assert.ok("error" in startInput({ agent: null, account: null, text: "", root: null, surface: "web" }));
});

test("the new thread's id is read from either shape", () => {
  assert.equal(threadIdOf({ id: "t1" }), "t1");
  assert.equal(threadIdOf({ thread: { id: "t2" } }), "t2");
  assert.equal(threadIdOf({}), null);
});

test("a chat started from inside a project names it, and one started anywhere else names none", () => {
  assert.deepEqual(startInput({ agent: null, account: null, text: "", root: "/r", surface: "web", project: "harlow" }), { input: { surface: "web", cwd: "/r", project: "harlow" } });
  assert.deepEqual(startInput({ agent: null, account: null, text: "", root: "/r", surface: "web", project: "" }), { input: { surface: "web", cwd: "/r" } });
  assert.deepEqual(startInput({ agent: null, account: null, text: "", root: "/r", surface: "web", project: null }), { input: { surface: "web", cwd: "/r" } });
});

test("a project's page names it by record id; threads.start takes the short name the box gives for it", () => {
  assert.equal(isProjectRecordId("7f9c2c0e-1d1b-4b6e-9a53-0c5f7d0e6a11"), true);
  assert.equal(isProjectRecordId("harlow"), false);
  assert.equal(isProjectRecordId(null), false);
  assert.equal(slugFromRef({ id: "x", slug: "harlow", name: "Harlow" }), "harlow");
  assert.equal(slugFromRef({ id: "x", slug: "" }), null);
  assert.equal(slugFromRef(null), null);
});
