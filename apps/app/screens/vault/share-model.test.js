import "../../../../scripts/mac-test-guard.mjs";
// The share sheet's rules, without a screen: which levels each grantee may hold, which agents are offered, what the notes say, and what is left to add. The words are the owner's: Fill in, Read, Edit and rotate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS, copyWarning, allowedLevels, levelWord, offeredAgents, candidates, loginNotes, connectionNote, groupSub, nameOf } from "./share-model.js";

const people = [{ id: "chris", kind: "person", name: "Chris" }, { id: "dana", kind: "person", name: "Dana" }];
const agents = [{ id: "kit", kind: "agent", name: "Kit", instructors: ["alex", "chris", "dana"] }, { id: "juno", kind: "agent", name: "Juno", instructors: ["alex"] }, { id: "atlas", kind: "agent", name: "Atlas", instructors: ["chris"] }];
const groups = [{ id: "billing", kind: "group", name: "Billing", people: ["chris", "dana"], agents: ["kit"] }];

test("the three levels and their words", () => {
  assert.deepEqual(LEVELS.map(l => l[1]), ["Can use it, without seeing it", "Can see it", "Can change it"]);
  assert.equal(levelWord("use"), "Can use it, without seeing it"); assert.equal(levelWord("edit"), "Can change it");
});

test("an agent can only be given Fill in, and so can anyone for an app connection; a person or a group holds all three on an item", () => {
  assert.deepEqual(allowedLevels("agent"), ["use"]);
  assert.deepEqual(allowedLevels("person", { connection: true }), ["use"]);
  assert.deepEqual(allowedLevels("group", { connection: true }), ["use"]);
  assert.deepEqual(allowedLevels("person"), ["use", "reveal", "edit"]);
  assert.deepEqual(allowedLevels("group"), ["use", "reveal", "edit"]);
  assert.deepEqual(allowedLevels("person", { levels: ["use"] }), ["use"], "a box that only honours Fill in for members hides the others");
  assert.deepEqual(allowedLevels("group", { levels: ["use", "reveal"] }), ["use", "reveal"]);
  assert.deepEqual(allowedLevels("agent", { levels: ["use", "reveal", "edit"] }), ["use"], "never more than Fill in for an agent, whatever the box offers");
});

test("only the agents the member may instruct are offered; the owner of the Space is offered all", () => {
  assert.deepEqual(offeredAgents(agents, "alex").map(a => a.id), ["kit", "juno"]);
  assert.deepEqual(offeredAgents(agents, "chris").map(a => a.id), ["kit", "atlas"]);
  assert.deepEqual(offeredAgents(agents, null).map(a => a.id), ["kit", "juno", "atlas"], "no member named: the owner's view, every agent");
  assert.deepEqual(offeredAgents([{ id: "x", kind: "agent", name: "X" }], "alex").map(a => a.id), ["x"], "an agent with no instructor list is offered");
});

test("what is left to add: not those who already hold it, narrowed by the search, agents filtered, Everyone only for a whole vault", () => {
  const pool = (o = {}) => candidates({ people, groups, agents, shares: [], me: "alex", ...o });
  assert.deepEqual(pool().agents.map(a => a.id), ["kit", "juno"]);
  assert.deepEqual(pool({ shares: [{ id: "chris", level: "use" }, { id: "kit", level: "use" }] }).people.map(p => p.id), ["dana"]);
  assert.deepEqual(pool({ shares: [{ id: "kit", level: "use" }] }).agents.map(a => a.id), ["juno"]);
  assert.deepEqual(pool({ q: "DAN" }).people.map(p => p.id), ["dana"]);
  assert.deepEqual(pool().groups.map(g => g.id), ["billing"]);
  assert.deepEqual(pool({ everyone: true }).groups.map(g => g.id), ["billing", "everyone"]);
});

test("the login note and who else can instruct the agent; none without an agent", () => {
  const sh = [{ id: "kit", level: "use" }, { id: "juno", level: "use" }, { id: "chris", level: "reveal" }];
  assert.deepEqual(loginNotes(sh, agents, "alex"), ["Your agent can use this login while you're away.", "Chris and Dana can also instruct Kit, so they can ask it to use this login."]);
  assert.deepEqual(loginNotes([{ id: "chris", level: "reveal" }], agents, "alex"), []);
  assert.deepEqual(loginNotes([{ id: "juno", level: "use" }], agents, "alex"), ["Your agent can use this login while you're away."], "an agent only you instruct adds no second line");
});

test("the connection note names the agents it is shared with, and says what still waits", () => {
  assert.equal(connectionNote("Clio", [{ id: "kit", level: "use" }], agents), "Kit can act in Clio as you, and only use it, without seeing it. Anything that sends or changes data still waits for your yes.");
  assert.equal(connectionNote("Clio", [{ id: "kit", level: "use" }, { id: "juno", level: "use" }], agents), "Kit and Juno can act in Clio as you, and only use it, without seeing it. Anything that sends or changes data still waits for your yes.");
  assert.match(connectionNote("Clio", [], agents), /^An agent you share it with can act in Clio as you/);
});

test("a group's line counts its people and agents", () => {
  assert.equal(groupSub({ people: ["a", "b"], agents: ["k"] }), "2 people, 1 agent");
  assert.equal(groupSub({ people: ["a"], agents: [] }), "1 person");
  assert.equal(groupSub({ people: [], agents: ["k", "j"] }), "2 agents");
  assert.equal(groupSub({ people: [], agents: [] }), "Nobody yet");
});

test("a name for any id, including Everyone", () => {
  assert.equal(nameOf("chris", { people, groups, agents }), "Chris");
  assert.equal(nameOf("everyone", { people, groups, agents }), "Everyone in the Space");
  assert.equal(nameOf("nope", { people, groups, agents }), "nope");
});

test("a share that lets someone see the value says they can copy it, and that taking it back does not undo that", () => {
  const line = "They can see and copy this. Taking it back later doesn't undo that; rotate it if you need to.";
  assert.equal(copyWarning([{ id: "chris", level: "reveal" }]), line);
  assert.equal(copyWarning([{ id: "chris", level: "use" }, { id: "dana", level: "edit" }]), line);
  assert.equal(copyWarning([{ id: "kit", level: "use" }]), null, "Fill in shows nothing, so there is nothing to copy");
  assert.equal(copyWarning([]), null);
});
