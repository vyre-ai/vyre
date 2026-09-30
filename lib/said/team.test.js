// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamIntents } from "./team.js";
import { matches } from "./match.js";

const W = {
  project: "harlow-legal",
  roles: [{ role: "design" }, { role: "backend" }, { role: "front-end" }],
  agents: ["kit", "juno2"],
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

test("records nothing in doubt", () => {
  for (const t of ["Should I retire the designer?", "If it fails, retire the designer.", "Don't retire the designer.", "I'll retire the designer later.",
    "Whenever it slips, retire the designer.", "Retire the designer after review.", "Retire the designer and the backend teammate.".replace(" and the backend teammate", " role before the backend teammate"),
    "Retire someone.", "Turn on the inbox duty.", "Give the designer a duty that checks the inbox.", "Enable the backup duty.", "Edit the backup duty.",
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
