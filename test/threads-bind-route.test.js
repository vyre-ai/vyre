// @ts-check
// The daemon's threads.bind route reads the caller's process ancestry with the imported `ancestry()`; a local `const ancestry` in the same handler once shadowed it and broke the call before any
// check ran (sessions found it). A real daemon: the call must come back as a structured answer, never an exception. A test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";

test("threads.bind through the daemon's route answers with a structured result for a pid that is not the caller's, with no exception", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await call("threads.bind", { pid: 1, session: "s_probe" }, { root, caller: "cli" });
  assert.ok(r && typeof r === "object", "an answer");
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /ancestry is not a function|before initialization|is not defined|internal/i, text);
  assert.ok(r.error || r.data, "either a refusal or a result: " + text);
});
