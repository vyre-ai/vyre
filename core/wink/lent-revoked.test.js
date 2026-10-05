import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lentRevoked } from "./lent-revoked.js";

const world = (host = "srv_home") => {
  const calls = [], logs = [];
  const call = async (tool, input) => { calls.push([tool, input]); if (tool === "spaces.server.of") return { data: { device: input.space === "spc_hosted" ? host : null } }; if (tool === "runner.revoke") return { data: { revoked: true } }; throw new Error("unexpected " + tool); };
  return { calls, logs, fn: lentRevoked({ call, log: m => logs.push(m) }) };
};

test("the Space's own home ends this computer's grant: the runner is told, once", async () => {
  const w = world();
  assert.deepEqual(await w.fn({ space: "spc_hosted" }, "srv_home"), { ok: true, revoked: true });
  assert.deepEqual(w.calls.filter(c => c[0] === "runner.revoke"), [["runner.revoke", { space: "spc_hosted" }]]);
});

test("another paired server, an unknown connection, a Space this computer knows no server for, and a bad Space name cannot end it or block it", async () => {
  const w = world();
  await assert.rejects(w.fn({ space: "spc_hosted" }, "srv_other"), e => e.code === "denied");
  await assert.rejects(w.fn({ space: "spc_hosted" }, ""), e => e.code === "denied");
  await assert.rejects(w.fn({ space: "spc_unknown" }, "srv_home"), e => e.code === "denied");
  await assert.rejects(w.fn({ space: "../x" }, "srv_home"), e => e.code === "bad_input");
  await assert.rejects(w.fn({}, "srv_home"), e => e.code === "bad_input");
  assert.equal(w.calls.filter(c => c[0] === "runner.revoke").length, 0, "nothing was revoked by any of them");
});
