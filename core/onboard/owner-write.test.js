// @ts-check
// HD-1: the onboarding writers are the person's own; a model client or another module is refused, and once the box has an owner a write needs presence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerWrite } from "./index.js";

const code = (/** @type {() => void} */ f) => { try { f(); return "ok"; } catch (e) { return /** @type {any} */ (e).code; } };

test("HD-1: a model client, an agent, a hook or another module is refused whether or not an owner exists", () => {
  for (const c of ["mcp", "mcp:thread", "mcp:agent", "anonymous", "hook", "module:other", "agent:kit", "thread:1 agent:kit", "tailnet-guest:x", ""]) {
    assert.equal(code(() => ownerWrite(c, {}, "x", false)), "denied", c);
    assert.equal(code(() => ownerWrite(c, {}, "x", true)), "denied", c);
  }
  assert.equal(code(() => ownerWrite("deck", { agent: "kit" }, "x", true)), "denied", "a person surface carrying an agent claim");
});

test("HD-1: no write before the server has an owner (pair_first); afterwards the person's surfaces pass (the registry asks their presence)", () => {
  for (const c of ["cli", "local", "deck", "capsule", "mobile", "onboard", "device:abc", "setup:ab12", "tailnet:mac", "module:onboard"]) {
    assert.equal(code(() => ownerWrite(c, {}, "x", false)), "pair_first", c);
    assert.equal(code(() => ownerWrite(c, {}, "x", true)), "ok", c);
  }
  assert.equal(code(() => ownerWrite("deck", {}, "x", false, false)), "ok", "a read-only action needs no owner");
});
