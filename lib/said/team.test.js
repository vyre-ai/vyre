// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamIntents } from "./team.js";
import { matches } from "./match.js";

const W = {
  project: "harlow-legal",
  roles: [{ role: "design" }, { role: "backend" }, { role: "front-end" }],
  agents: ["kit", "juno2"],
  duties: [
    { id: "a1b2c3d4", teammate: "design-harlow-legal", title: "inbox triage every morning", hash: "0123456789ab", enabled: false, started: false },
    { id: "e5f6a7b8", teammate: "backend-harlow-legal", title: "nightly backup check", hash: "ba9876543210", enabled: false, started: false },
    { id: "c9d0e1f2", teammate: "backend-harlow-legal", title: "weekly report", hash: "ffffffffffff", enabled: true, started: true },
  ],
};
const keys = (t, w = W) => teamIntents(t, w).intents.map(i => i.to[0]);

test("retire: the role the person named, exactly", () => {
  assert.deepEqual(keys("Retire the designer."), ["team.retire:harlow-legal/design"]);
  assert.deepEqual(keys("please retire the backend teammate"), ["team.retire:harlow-legal/backend"]);
  assert.deepEqual(keys("Retire the front end teammate."), ["team.retire:harlow-legal/front-end"]);
});

test("fill: a named agent, or the default helper when the person says so", () => {
  assert.deepEqual(keys("Fill the design role with kit."), ["team.role.fill:harlow-legal/design/kit"]);
  assert.deepEqual(keys("Make kit the designer."), ["team.role.fill:harlow-legal/design/kit"]);
  assert.deepEqual(keys("Put the design role back on the default."), ["team.role.fill:harlow-legal/design/default"]);
});

test("fill: a verb that only looks like a role records nothing", () => {
  assert.deepEqual(keys("Have kit design the intake form."), []);
  assert.deepEqual(keys("Fill the design role."), [], "no agent and no default named");
});

test("fill needs its own shape: a common verb with a role and a name in the clause is not one", () => {
  for (const t of ["Have the designer review kit's work.", "Let the designer use kit.", "Make the designer send kit the files.", "Put kit's draft with the designer.",
    "Set the design role aside for kit.", "Use kit for the design review.", "Give kit a duty.", "Start a duty for the designer.", "Make the designer a coffee.",
    "Update the designer about the duty."]) {
    assert.deepEqual(keys(t), [], t);
  }
  for (const [t, key] of [
    ["Assign kit to the design role.", "team.role.fill:harlow-legal/design/kit"],
    ["Put kit on the design teammate.", "team.role.fill:harlow-legal/design/kit"],
    ["Switch the backend role to kit.", "team.role.fill:harlow-legal/backend/kit"],
    ["Have kit take the designer.", "team.role.fill:harlow-legal/design/kit"],
    ["Staff the design role using kit.", "team.role.fill:harlow-legal/design/kit"],
  ]) assert.deepEqual(keys(t), [key], t);
});

test("a duty is started by its own name, pinned to the hash team.duties.list gave", () => {
  assert.deepEqual(keys("Turn on the inbox duty."), ["team.duties.start:design-harlow-legal/a1b2c3d4@0123456789ab"]);
  assert.deepEqual(keys("Turn the backup duty on."), ["team.duties.start:backend-harlow-legal/e5f6a7b8@ba9876543210"]);
  assert.deepEqual(keys("Please start the inbox triage duty"), ["team.duties.start:design-harlow-legal/a1b2c3d4@0123456789ab"]);
  for (const t of ["Turn off the inbox duty.", "Pause the inbox duty.", "Turn on the weekly duty.", "Turn on the duty.",
    "Should I turn on the inbox duty?", "If it is quiet, turn on the inbox duty.", "Edit the backup duty.", "Give the designer a duty that checks the inbox.", "Create the inbox duty."]) {
    assert.deepEqual(keys(t), [], t);
  }
  assert.deepEqual(keys("Turn on the inbox duty.", { ...W, duties: [] }), [], "no candidate duty");
  const it = teamIntents("Turn on the inbox duty.", W).intents[0];
  const hold = { kind: "act_out", channel: "team", to_ids: it.to_ids, created_at: 0, when: it.when, limits: {} };
  const call = key => ({ kind: "act_out", channel: "team", to_ids: [key], at: 60_000 });
  assert.ok(matches(hold, call("team.duties.start:design-harlow-legal/a1b2c3d4@0123456789ab")));
  assert.equal(matches(hold, call("team.duties.start:design-harlow-legal/a1b2c3d4@aaaaaaaaaaaa")), false, "the text changed since the person said yes");
});

test("records nothing in doubt", () => {
  for (const t of ["Should I retire the designer?", "If it fails, retire the designer.", "Don't retire the designer.", "I'll retire the designer later.",
    "Whenever it slips, retire the designer.", "Retire the designer after review.", "Retire the designer and the backend teammate.".replace(" and the backend teammate", " role before the backend teammate"),
    "Retire someone.",
    "Fill the design role with kit and juno2."]) {
    assert.deepEqual(keys(t), [], t);
  }
  assert.deepEqual(keys("Retire the designer.", null), []);
  assert.deepEqual(keys("Retire the designer.", { project: "" }), []);
  assert.deepEqual(keys("Retire the designer.", { project: "p", roles: [] }), []);
});

test("two roles named in one clause: nothing", () => {
  const r = teamIntents("Retire the designer and the backend teammate.", W);
  assert.equal(r.intents.length, 0);
  assert.equal(r.skipped[0].reason, "ambiguous_role");
});

test("only the person's unquoted words", () => {
  assert.deepEqual(keys("Here's what Sam wrote:\nPlease retire the designer."), []);
});

test("the right act is released, another role, project or act is refused, and a plain ask expires in 15 minutes", () => {
  const r = teamIntents("Retire the designer.", W).intents[0];
  assert.equal(r.when.window_minutes, 15);
  assert.equal(r.channel, "team");
  const it = { kind: "act_out", channel: "team", to_ids: r.to_ids, created_at: 0, when: r.when, limits: {} };
  const call = (key, at = 60_000) => ({ kind: "act_out", channel: "team", to_ids: [key], at });
  assert.ok(matches(it, call("team.retire:harlow-legal/design")));
  assert.equal(matches(it, call("team.retire:harlow-legal/backend")), false);
  assert.equal(matches(it, call("team.retire:northwind-bakery/design")), false);
  assert.equal(matches(it, call("team.role.fill:harlow-legal/design/kit")), false);
  assert.equal(matches(it, call("team.retire:harlow-legal/design", 16 * 60_000)), false);
  assert.equal(matches(it, call("team.retire:harlow-legal/design"), { used: 1 }), false);
});

test("team.add: the role the words name, in the thread's project, never a live or reserved one", () => {
  const k = (t, w = W) => teamIntents(t, w).intents.map(i => i.to[0]);
  assert.deepEqual(k("Add a researcher teammate to this project."), ["team.add:harlow-legal/researcher"]);
  assert.deepEqual(k("Make me a growth teammate."), ["team.add:harlow-legal/growth"]);
  assert.deepEqual(k("Please hire another dev-ops teammate."), ["team.add:harlow-legal/dev-ops"]);
  assert.deepEqual(k("Create a new researcher teammate."), ["team.add:harlow-legal/researcher"]);
  assert.deepEqual(k("Add a teammate for research."), ["team.add:harlow-legal/research"]);
  for (const t of ["Add a new teammate.", "Add an integrator teammate.", "Add a design teammate.", "Add a front-end teammate.", "Should I add a researcher teammate?", "If it helps, add a researcher teammate.",
    "Don't add a researcher teammate.", "I'll add a researcher teammate later.", "Add a researcher.", "Add a researcher teammate when you can.", "Here's the email:\nAdd a researcher teammate."]) {
    assert.deepEqual(k(t), [], t);
  }
  assert.deepEqual(k("Add a researcher teammate.", { project: "" }), []);
  const r = teamIntents("Add a researcher teammate.", W).intents[0];
  assert.equal(r.channel, "team");
  assert.equal(r.when.window_minutes, 15);
  const it = { kind: "act_out", channel: "team", to_ids: r.to_ids, created_at: 0, when: r.when, limits: {} };
  const call = key => ({ kind: "act_out", channel: "team", to_ids: [key], at: 60_000 });
  assert.ok(matches(it, call("team.add:harlow-legal/researcher")));
  assert.equal(matches(it, call("team.add:harlow-legal/designer")), false, "another role");
  assert.equal(matches(it, call("team.add:northwind-bakery/researcher")), false, "another project");
  assert.equal(matches(it, call("team.add:harlow-legal/researcher"), { used: 1 }), false, "one use");
});
