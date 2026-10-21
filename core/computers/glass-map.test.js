// @ts-check
// The Computer tab says live from an agent-user row. Glass must know that same computer, as computer:<id>, and open the agent's own screen.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { glassComputers } from "./glass-map.js";

test("an agent the Computer tab calls live is a glass computer, even without computer: true", () => {
  const listed = [
    { agent: "kit", state: "running", screen: 1, thread: null, viewers: 0, takeover: null, paused: false, label: null },
  ];
  const space = [
    { agent: "juno", state: "live" },
    { agent: "ads", state: "asleep" },
    { agent: "pax", state: "none" },
  ];
  const rows = glassComputers(listed, space);
  const by = Object.fromEntries(rows.map((r) => [r.agent, r]));
  assert.equal(by.juno.state, "live");
  assert.equal(by.juno.perAgent, true, "watch opens the agent's own screen");
  assert.equal(`computer:${by.juno.agent}`, "computer:juno");
  assert.equal(by.ads.state, "asleep");
  assert.equal(by.ads.perAgent, true);
  assert.equal(by.kit.state, "running");
  assert.equal(by.kit.perAgent, false, "a desktop with no agent-user row stays a desktop");
  assert.equal(by.pax, undefined, "no row, so Glass does not invent a computer");
  const both = glassComputers([{ agent: "kit", state: "running", label: "Kit's desk" }], [{ agent: "kit", state: "live" }]);
  assert.equal(both.length, 1);
  assert.equal(both[0].state, "live", "the space screen wins, so the pane and Glass agree");
  assert.equal(both[0].perAgent, true);
  assert.equal(both[0].label, "Kit's desk");
});
