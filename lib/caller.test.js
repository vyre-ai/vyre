// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPerson, isAgent, agentName, isOwnerDevice } from "./caller.js";

test("caller: the person's own surfaces read as the person", () => {
  for (const c of ["cli", "local", "deck", "capsule"]) {
    assert.equal(isPerson(c), true, c);
    assert.equal(isPerson({ caller: c }), true, c);
    assert.equal(isAgent(c), false, c);
  }
});

test("caller: a bare model session, the harness, a hook and a guest are none of them the person", () => {
  for (const c of ["mcp", "harness", "hook", "module:vault", "tailnet-guest:abc123", "tailnet-guest:abc123:agent:kit"]) {
    assert.equal(isPerson(c), false, c);
  }
});

test("caller: an agent's own claim is never the person, even under a caller kind PERSON_SURFACES would otherwise admit", () => {
  // The exact transport-spoofing shape e2e found: "cli:agent:kit" reads its own callerKind as
  // "cli" (a person surface), which is exactly why isPerson checks the agent claim first.
  for (const c of ["mcp:agent:kit", "cli:agent:kit", "cli agent:kit", "harness:agent:kit", "deck:agent:kit"]) {
    assert.equal(isAgent(c), true, c);
    assert.equal(agentName(c), "kit", c);
    assert.equal(isPerson(c), false, c);
  }
});

test("caller: an agent claim with no name still counts as a claim, not as no claim at all", () => {
  assert.equal(isAgent("cli agent:"), true);
  assert.equal(agentName("cli agent:"), "(unnamed)");
  assert.equal(isPerson("cli agent:"), false);
});

test("caller: no agent name is not, by itself, the person - the bug this replaces", () => {
  // The exact regression this lib exists to stop: several modules independently read "no agent
  // named" as "must be the person" instead of checking who actually is. None of these has any
  // agent claim, and none of them is the person either.
  for (const c of ["mcp", "harness", "hook", "tailnet-guest:x"]) {
    assert.equal(isAgent(c), false, c);
    assert.equal(isPerson(c), false, c);
  }
});

test("caller: the owner's own device over the tailnet or a relay pairing is the person, and isOwnerDevice agrees", () => {
  for (const c of ["tailnet:alex@example.com", "device:abcdefghijklmnop"]) {
    assert.equal(isOwnerDevice(c), true, c);
    assert.equal(isPerson(c), true, c);
  }
  // An agent's own tailnet node is neither.
  assert.equal(isOwnerDevice("tailnet:agent:kit"), false);
  assert.equal(isPerson("tailnet:agent:kit"), false);
});

test("caller: agentName is null for anything that names no agent, whatever else it is", () => {
  for (const c of ["cli", "mcp", "tailnet:alex@example.com", "device:abcdefghijklmnop", ""]) {
    assert.equal(agentName(c), null, c);
  }
});

test("caller: a bare string and a {caller} meta object are read the same way", () => {
  assert.equal(isPerson("deck"), isPerson({ caller: "deck" }));
  assert.equal(isAgent("mcp:agent:kit"), isAgent({ caller: "mcp:agent:kit" }));
  assert.equal(agentName("harness:agent:juno"), agentName({ caller: "harness:agent:juno" }));
});
