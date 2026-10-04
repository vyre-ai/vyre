// @ts-check
// A vyred on a temp home never looks for or pairs with a real box (a stress run on the test box
// found the user's live box and sent it a pairing request). The rule, and the link module under it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { realBoxAllowed, realHome } from "../core/config/dialogs.js";
import { tempHome } from "./helpers.js";

test("link guard: only ~/.vyre, or a home that says so, may reach a real box", () => {
  const temp = path.join(os.tmpdir(), "vy-guard");
  assert.equal(realBoxAllowed(temp, {}), false);
  assert.equal(realBoxAllowed(realHome(), {}), true);
  assert.equal(realBoxAllowed(temp, { VYRE_ALLOW_DIALOGS: "1" }), false, "allowing dialogs is not allowing a real box");
  assert.equal(realBoxAllowed(temp, { VYRE_ALLOW_REAL_BOX: "1" }), true);
  assert.equal(realBoxAllowed(temp, { VYRE_ALLOW_REAL_BOX: "1", VYRE_NO_DIALOGS: "1" }), true, "no dialogs is not no pairing on request");
  assert.equal(realBoxAllowed(realHome(), { NODE_TEST_CONTEXT: "child" }), false, "never under tests");
  assert.equal(realBoxAllowed(temp, { VYRE_NO_DIALOGS: "1" }), false, "a stress run sets no-dialogs and still may not pair");
});

test("link guard: a temp-home vyred refuses link.find and link.pair to a real address, and says how to allow it", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [], vault: { keystore: "file" } }));
  const prev = process.env.VYRE_TAILSCALE_BIN;
  delete process.env.VYRE_TAILSCALE_BIN;
  t.after(() => { if (prev !== undefined) process.env.VYRE_TAILSCALE_BIN = prev; });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const find = await call("link.find", {}, { root });
  assert.equal(find.error && find.error.code, "not_real_home");
  assert.match(find.error.message, /is not ~\/\.vyre[\s\S]*VYRE_ALLOW_REAL_BOX=1/);
  const pair = await call("link.pair", { box: "https://vyre.example-tail.ts.net" }, { root });
  assert.equal(pair.error && pair.error.code, "not_real_home");
  // A box on this machine's loopback is a test's or a dev world's own: not refused for this reason.
  const local = await call("link.pair", { box: "https://127.0.0.1:1" }, { root });
  assert.notEqual(local.error && local.error.code, "not_real_home");
});
