// @ts-check
// The one dim tip line after a command (the tips module, tips.next): only for a person at a
// terminal, never for a script, CI, --json, a failure, or vyre up, down and tips. A fake tool
// stands in for vyred, so nothing here needs one running.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tipsWanted, tip } from "./index.js";

const TTY = { out: true, err: true };

test("tip line: only at an interactive terminal, and never after up, down or tips", () => {
  assert.equal(tipsWanted("threads", {}, TTY), true);
  assert.equal(tipsWanted("threads", {}, { out: false, err: true }), false, "piped stdout");
  assert.equal(tipsWanted("threads", {}, { out: true, err: false }), false, "stderr to a file");
  assert.equal(tipsWanted("threads", { CI: "1" }, TTY), false);
  assert.equal(tipsWanted("threads", { VYRE_NO_TIPS: "1" }, TTY), false);
  for (const n of ["up", "down", "tips"]) assert.equal(tipsWanted(n, {}, TTY), false, n);
});

test("tip line: asks tips.next for the verb's module, marked shown, 150 ms at most, backticks gone", async t => {
  const lines = [];
  t.mock.method(process.stderr, "write", chunk => { lines.push(String(chunk)); return true; });
  const asked = [];
  const ask = async (tool, input, o) => { asked.push({ tool, input, o }); return { data: { tip: { id: "t1", text: "Run `vyre threads watch <id>` to follow a thread  live." }, why: "ok" } }; };
  assert.equal(await tip("threads", ask), "tip: Run vyre threads watch <id> to follow a thread live.");
  assert.deepEqual(asked, [{ tool: "tips.next", input: { surface: "cli", context: { module: "threads" }, mark: true }, o: { timeout: 150 } }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].replace(/\x1b\[[0-9;]*m/g, ""), /^tip: Run vyre threads watch <id> to follow a thread live\.\n$/);
});

test("tip line: nothing when there is no tip, the tool is missing, or vyred is down", async t => {
  const lines = [];
  t.mock.method(process.stderr, "write", chunk => { lines.push(String(chunk)); return true; });
  assert.equal(await tip("vault", async () => ({ data: { tip: null, why: "gap" } })), null);
  assert.equal(await tip("vault", async () => ({ error: { code: "no_such_tool" } })), null);
  assert.equal(await tip("vault", async () => ({ error: { code: "unreachable" } })), null);
  assert.equal(await tip("vault", async () => { throw new Error("socket closed"); }), null);
  assert.deepEqual(lines, []);
});
