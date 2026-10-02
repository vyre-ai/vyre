// @ts-check
// `vyre uninstall` offers to hand the name.vyre.run address back before vyred goes down.

import test from "node:test";
import assert from "node:assert/strict";
import { keepName } from "./up.js";

const rig = (status, { tty = true, answer = "", release = { data: { name: "alex" } } } = {}) => {
  const calls = [], lines = [];
  return { calls, lines, io: { call: async (tool, input) => { calls.push([tool, input]); if (tool === "names.status") return status; return release; }, out: l => lines.push(l), ask: async () => answer, tty } };
};
const held = { data: { name: "alex", via: "vyre.run" } };

test("uninstall: a box with a name hands it back on yes or Enter, with the handoff flag", async () => {
  for (const answer of ["", "y", "Yes"]) {
    const r = rig(held, { answer });
    assert.equal(await keepName({ root: "/x", keep: false, release: false }, r.io), "handed");
    assert.deepEqual(r.calls.at(-1), ["names.release", { handoff: true }]);
    assert.match(r.lines.join(" "), /alex\.vyre\.run is handed back/);
  }
});

test("uninstall: no keeps it held with the 72-hour note, a script is told how, and --release-name and --keep-name skip the question", async () => {
  let r = rig(held, { answer: "n" });
  assert.equal(await keepName({ root: "/x", keep: false, release: false }, r.io), "held");
  assert.ok(!r.calls.some(c => c[0] === "names.release"));
  assert.match(r.lines.join(" "), /72-hour/);
  r = rig(held, { tty: false });
  assert.equal(await keepName({ root: "/x", keep: false, release: false }, r.io), "held");
  assert.match(r.lines.join(" "), /--release-name/);
  r = rig(held, { tty: false });
  assert.equal(await keepName({ root: "/x", keep: false, release: true }, r.io), "handed");
  r = rig(held);
  assert.equal(await keepName({ root: "/x", keep: true, release: false }, r.io), "kept");
  assert.equal(r.calls.length, 0);
});

test("uninstall: nothing to hand back when vyred is down or the box holds no name, and a refusal leaves it held", async () => {
  let r = rig({ error: { code: "unreachable" } });
  assert.equal(await keepName({ root: "/x", keep: false, release: false }, r.io), "none");
  r = rig({ data: { name: null, via: null } });
  assert.equal(await keepName({ root: "/x", keep: false, release: false }, r.io), "none");
  r = rig(held, { release: { error: { code: "denied", message: "no" } } });
  assert.equal(await keepName({ root: "/x", keep: false, release: true }, r.io), "failed");
  assert.match(r.lines.join(" "), /stays held/);
});
