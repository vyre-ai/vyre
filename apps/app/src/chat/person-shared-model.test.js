// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sharedView } from "./person-shared-model.js";

test("you and a person: your chat, the threads you share, the projects you are both on", () => {
  const v = sharedView({ person: { id: "per_d", name: "Dana" }, chat: { chat: "k1", threads: 3 }, threads: [{ thread: "t1", title: "Spring launch" }, { thread: "t2" }, { nope: 1 }], shared_threads: 5, projects: [{ urn: "u", name: "Northwind" }, { urn: "v" }] });
  assert.deepEqual(v, { chat: "k1", threads: [{ id: "t1", title: "Spring launch" }, { id: "t2", title: "New thread" }], count: 5, projects: ["Northwind"] });
  assert.deepEqual(sharedView(null), { chat: "", threads: [], count: 0, projects: [] });
});
