import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { scopeFor, sees } from "./scope.js";

const of = async cwd => (cwd.startsWith("/work/h") ? "harlow-legal" : null);

test("a person, a module and a hook see every project's watchers; an agent only its granted ones, and none when the grant is unknown", async () => {
  assert.equal((await scopeFor({}, of))("harlow-legal"), true, "no reach: not an agent");
  assert.equal((await scopeFor({ reach: { all: true } }, of))("harlow-legal"), true);
  const kit = await scopeFor({ reach: { all: false, projects: ["harlow-legal"] } }, of);
  assert.deepEqual([kit("harlow-legal"), kit("northwind"), kit(null)], [true, false, false]);
  assert.equal((await scopeFor({ reach: { all: false, projects: [] } }, of))("harlow-legal"), false, "an agent with no projects");
  assert.equal(sees({ reach: { all: false, projects: ["harlow-legal"] } }, "northwind"), false);
});

test("a plain model session sees its folder's project; where the folder is unknown, nothing", async () => {
  const at = cwd => scopeFor({ peerSession: "1:2", peerCwd: cwd }, of);
  assert.equal((await at("/work/h/x"))("harlow-legal"), true);
  assert.equal((await at("/work/h/x"))("northwind"), false);
  assert.equal((await at(null))("harlow-legal"), false, "no folder");
  assert.equal((await at("/elsewhere"))("harlow-legal"), false, "a folder in no project");
  assert.equal((await scopeFor({ peerSession: null, peerCwd: null }, of))("harlow-legal"), false, "the OS would not say who");
  assert.equal((await scopeFor({ peerCwd: "/work/h" }, async () => { throw new Error("projects is down"); }))("harlow-legal"), false, "fail closed");
});

test("a verified thread session sees its own thread's project; nothing if the thread has none or the lookup fails", async () => {
  const ofThread = async t => (t === "t-harlow" ? "harlow-legal" : t === "t-none" ? null : (() => { throw new Error("no such thread"); })());
  const at = t => scopeFor({ thread: t }, of, ofThread);
  assert.equal((await at("t-harlow"))("harlow-legal"), true);
  assert.equal((await at("t-harlow"))("northwind"), false);
  assert.equal((await at("t-none"))("harlow-legal"), false, "a thread with no project");
  assert.equal((await at("t-gone"))("harlow-legal"), false, "the lookup fails");
  // An agent's grant outranks the thread it is calling from.
  assert.equal((await scopeFor({ thread: "t-harlow", reach: { all: true } }, of, ofThread))("northwind"), true);
});
