// @ts-check
// The Create your assistant card on Now: when it shows, and what it reads.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("it shows for an owner or admin whose space has no assistant, and for nobody else", { skip: !strip }, async () => {
  const { shouldShow } = await import("./create-card-model.ts");
  const agents = [{ name: "rex", kind: "agent" }];
  assert.equal(shouldShow(agents, "owner"), true);
  assert.equal(shouldShow([], "admin"), true);
  assert.equal(shouldShow(agents, "member"), false);
  assert.equal(shouldShow(agents, undefined), false);
  assert.equal(shouldShow([{ name: "juno", kind: "assistant" }, ...agents], "owner"), false);
});

test("it stays away until the box has answered", { skip: !strip }, async () => {
  const { shouldShow, agentsOf } = await import("./create-card-model.ts");
  const { createCardSource } = await import("./create-card-source.ts");
  assert.equal(shouldShow(null, "owner"), false);
  assert.equal(shouldShow(undefined, "owner"), false);
  assert.equal(agentsOf({ not: "agents" }), null);
  assert.deepEqual(agentsOf({ agents: [{ name: "a", kind: "agent" }] }), [{ name: "a", kind: "agent" }]);
  const down = createCardSource(async () => ({ error: { code: "offline", message: "no" } }));
  assert.equal(await down.agents(), null);
  /** @type {string[]} */ const seen = [];
  const up = createCardSource(async (t) => { seen.push(t); return { data: [{ name: "juno", kind: "assistant" }] }; });
  assert.deepEqual(await up.agents(), [{ name: "juno", kind: "assistant" }]);
  assert.deepEqual(seen, ["agents.list"]);
});

test("it opens the New assistant page and its words are plain", { skip: !strip }, async () => {
  const { CREATE_ASSISTANT } = await import("./create-card-model.ts");
  assert.equal(CREATE_ASSISTANT.href, "/u/settings/assistants/new");
  assert.doesNotMatch(Object.values(CREATE_ASSISTANT).join(" "), /server|install|terminal/i);
});
