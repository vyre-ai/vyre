// @ts-check
// The composer's native slash set, the kernel router, and the static picker list stay aligned.
import "../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { routeComposerLine } from "./thread-composer-route.js";
import { COMMANDS } from "../apps/app/src/chat/core/commands.js";

/** Commands the product documents for members (move is composer-local; routing still sends it as a session line). */
const DOCUMENTED = [
  "clear", "compact", "resume", "model", "effort", "init", "memory", "review", "export", "usage", "agents", "help", "status",
  "plan", "permissions", "mcp", "rewind", "remember", "later", "find", "move",
];

const SEND = new Set([
  "clear", "compact", "resume", "init", "memory", "review", "export", "usage", "agents", "help", "status",
  "plan", "permissions", "mcp", "move",
]);

test("every documented native slash is in the composer picker and routes like threads.slash", () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const name of DOCUMENTED) {
    assert.ok(names.has(name), `${name} is in COMMANDS`);
    const line = name === "model" ? "/model" : name === "find" ? "/find q" : name === "later" ? "/later at 9am x" : name === "remember" ? "/remember x" : name === "effort" ? "/effort low" : name === "rewind" ? "/rewind" : `/${name}`;
    const r = routeComposerLine(line);
    if (name === "remember") assert.equal(r.tool, "threads.remember");
    else if (name === "model") assert.equal(r.tool, "threads.get");
    else if (name === "effort") assert.equal(r.tool, "threads.effort");
    else if (name === "later") assert.equal(r.tool, "planner.add");
    else if (name === "find") assert.equal(r.tool, "recall.search");
    else if (name === "rewind") assert.equal(r.tool, "threads.rewind");
    else if (SEND.has(name)) {
      assert.equal(r.tool, "threads.send", name);
      assert.equal(r.sendAsMessage, true, name);
    }
  }
});

test("aliases search and remind map to find and later", () => {
  assert.equal(routeComposerLine("/search lease").tool, "recall.search");
  assert.equal(routeComposerLine("/remind at 9am tea").tool, "planner.add");
});
