// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPerson, isAgent, agentName, isOwnerDevice, isDevice, isSpaceMember } from "./caller.js";

test("caller: the person's own surfaces read as the person", () => {
  for (const c of ["cli", "local", "deck", "capsule"]) {
    assert.equal(isPerson(c), true, c);
    assert.equal(isPerson({ caller: c }), true, c);
    assert.equal(isAgent(c), false, c);
  }
});

test("caller: a bare model session, the harness, a hook and a guest are none of them the person", () => {
  for (const c of ["mcp", "harness", "hook", "module:vault", "guest:abc123", "guest:abc123:agent:kit"]) {
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
  for (const c of ["mcp", "harness", "hook", "guest:x"]) {
    assert.equal(isAgent(c), false, c);
    assert.equal(isPerson(c), false, c);
  }
});

test("caller: the owner's own paired device is the person, and isOwnerDevice agrees", () => {
  for (const c of ["device:nw3b43olz4rzbzfe", "device:abcdefghijklmnop"]) {
    assert.equal(isOwnerDevice(c), true, c);
    assert.equal(isPerson(c), true, c);
  }
  // An agent is neither.
  assert.equal(isOwnerDevice("agent:kit"), false);
  assert.equal(isPerson("agent:kit"), false);
});

test("caller: agentName is null for anything that names no agent, whatever else it is", () => {
  for (const c of ["cli", "mcp", "device:nw3b43olz4rzbzfe", "device:abcdefghijklmnop", ""]) {
    assert.equal(agentName(c), null, c);
  }
});

test("caller: a thread label is never the person, even from a person-surface callerKind (e2e2, 2026-09-28)", () => {
  // callerKind strips "thread:" the same as "agent:" (ADR 0030), so these would otherwise read
  // as plain "cli"/"deck" - a person surface - despite carrying a Vyre-owned thread label.
  for (const c of ["cli:thread:x", "deck:thread:x", "mcp:thread:abc", "harness:thread:abc"]) {
    assert.equal(isPerson(c), false, c);
    assert.equal(isAgent(c), false, c); // a thread label is not an agent claim either - agentName stays null
  }
});

test("caller: a bare string and a {caller} meta object are read the same way", () => {
  assert.equal(isPerson("deck"), isPerson({ caller: "deck" }));
  assert.equal(isAgent("mcp:agent:kit"), isAgent({ caller: "mcp:agent:kit" }));
  assert.equal(agentName("harness:agent:juno"), agentName({ caller: "harness:agent:juno" }));
});

test("caller: device:<id> is the person's own device, and only that exact shape", () => {
  const ok = "device:abcdefghijklmnop";
  assert.equal(isDevice(ok), true);
  assert.equal(isDevice({ caller: ok }), true);
  assert.equal(isPerson(ok), true);
  for (const c of ["Device:abcdefghijklmnop", "device :abcdefghijklmnop", "device:", "device", "device:abc", "device:abcdefghijklmnopq", "device:ABCDEFGHIJKLMNOP", "device: abcdefghijklmnop",
    "device:abcdefghijklmnop:x", " device:abcdefghijklmnop", "device:abcdefghijklmnop\n", "device:abcdefghij\u200bklmnop", "\u200bdevice:abcdefghijklmnop", "dev\u200bice:abcdefghijklmnop"]) {
    assert.equal(isDevice(c), false, JSON.stringify(c));
  }
  for (const c of ["Device:abcdefghijklmnop", "device :abcdefghijklmnop", "device:", "device:abcdefghij\u200bklmnop", "dev\u200bice:abcdefghijklmnop"]) {
    assert.equal(isPerson(c), false, JSON.stringify(c));
    assert.equal(isOwnerDevice(c), false, JSON.stringify(c));
  }
});

test("caller: space:<person>@<space> is a visiting person, never the person themself and never an agent claim", () => {
  for (const c of ["space:alex@harlow", "space:juno@northwind.bakery", "space:a.b-c_d@x1"]) {
    assert.equal(isSpaceMember(c), true, c);
    assert.equal(isSpaceMember({ caller: c }), true, c);
    assert.equal(isPerson(c), false, c);
    assert.equal(isOwnerDevice(c), false, c);
    assert.equal(isAgent(c), false, c);
    assert.equal(agentName(c), null, c);
  }
  for (const c of ["Space:alex@harlow", "space :alex@harlow", "space:", "space", "space:alex", "space:@harlow", "space:alex@", "space: alex@harlow", "space:alex@harlow x", " space:alex@harlow",
    "space:alex@harlow\n", "space:al\u200bex@harlow", "space:alex@har\u200blow", "\u200bspace:alex@harlow", "space:alex@harlow:agent:kit", "device:abcdefghijklmnop"]) {
    assert.equal(isSpaceMember(c), false, JSON.stringify(c));
  }
  assert.equal(isPerson("space:alex@harlow:agent:kit"), false);
  assert.equal(isAgent("space:alex@harlow:agent:kit"), true, "an agent claim riding on a space label is still a claim");
});

test("caller: agent:<id> is an agent claim in any shape, parsed like agent:<name>, and never the person", () => {
  for (const c of ["agent:kit", "agent:kit", "device:abcdefghijklmnop:agent:kit"]) {
    assert.equal(isAgent(c), true, c);
    assert.equal(agentName(c), "kit", c);
    assert.equal(isPerson(c), false, c);
    assert.equal(isOwnerDevice(c), false, c);
  }
  assert.equal(agentName("agent:"), "(unnamed)");
  for (const c of ["Agent:kit", "AGENT:kit", "agent kit", "ag\u200bent:kit", "agentx:kit"]) {
    assert.equal(isAgent(c), false, JSON.stringify(c));
    assert.equal(isPerson(c), false, JSON.stringify(c));
  }
});
