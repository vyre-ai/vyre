// @ts-check
// agents.flow-say wakes a Flow's agent as the person, with the person's own grants, so it is the person's own voice (sec53's ruling, reach "person" in the manifest, and the handler's own caller check as a
// second layer). Through the real daemon: a named assistant on its CLI or MCP surface, an assistant that only claims a thread, and a bare MCP session are each refused before the body runs, and a person's
// own surface is not (it reaches the body and fails there for the Flow that does not exist).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

const INPUT = { agent: "juno", flow: "no-such-flow", text: "Why did run 8 fail?" };

test("agents.flow-say refuses an assistant and an MCP session, and runs for a person", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.ok(d.registry.tools.get("agents.flow-say"), "registered");
  assert.equal((await d.registry.call("agents.create", { name: "juno", kind: "agent" }, "cli")).error, undefined);
  const refused = [
    ["cli:agent:kit", "cli:agent:kit", undefined],
    ["mcp:agent:juno", "mcp:agent:juno", undefined],
    ["a person surface that only claims an assistant's thread", "cli", { thread: "t-1", agent: "kit" }],
    ["a bare mcp session", "mcp", undefined],
  ];
  for (const [who, caller, meta] of refused) {
    const r = await d.registry.call("agents.flow-say", INPUT, /** @type {string} */ (caller), /** @type {any} */ (meta));
    assert.ok(r.error, `${who} ran: ${JSON.stringify(r).slice(0, 160)}`);
    assert.equal(r.error.code, "denied", `${who}: ${JSON.stringify(r.error).slice(0, 160)}`);
  }
  for (const surface of ["cli", "deck"]) {
    const person = await d.registry.call("agents.flow-say", INPUT, surface);
    assert.ok(person.error, "no such Flow");
    // past the door and the handler's person check, the Flow's own layer answers: the box here has no Flow of that name, and no chain of a person's own (a plain surface, no kernel)
    const message = String(person.error.message);
    assert.ok(person.error.code === "not_found" || /a Flow is changed or run under a person's own chain/.test(message), `${surface} reached the body: ` + JSON.stringify(person.error).slice(0, 160));
    assert.ok(!/only a person writes|is not available to|person-only|person only/.test(message), `a person on ${surface} is not refused for who they are: ` + message.slice(0, 160));
  }
});
