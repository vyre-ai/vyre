#!/usr/bin/env node
// @ts-check
// A fake sight helper for tests: speaks the helper's NDJSON protocol and answers from a scenario
// in the FAKE_SIGHT environment variable, so the runner's real process handling (ids, change
// lines, crashes, timeouts) is exercised without a screen.
//
// Scenario keys: where, context (the bodies to answer with), state (a folder for once-only
// markers), crashOnce / hangOnce (a command that crashes or hangs the first time it is asked),
// notTrusted. Test-only commands: fake.change (write a change line), fake.count (requests seen).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const s = JSON.parse(process.env.FAKE_SIGHT || "{}");
/** @type {Record<string, number>} */
const count = {};
const once = (/** @type {string} */ name) => {
  const f = path.join(s.state, name);
  if (fs.existsSync(f)) return false;
  fs.writeFileSync(f, "1");
  return true;
};
const out = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");

readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  count[req.cmd] = (count[req.cmd] || 0) + 1;
  if (s.crashOnce === req.cmd && once("crashed")) process.exit(9);
  if (s.hangOnce === req.cmd && once("hung")) return;
  if (s.notTrusted && req.cmd !== "trust") return out({ id: req.id, error: "not allowed", code: "not_trusted" });
  if (req.cmd === "fake.change") { out({ changed: { pid: 4242, app: "Notes", bundle: "com.apple.Notes", window: "x" } }); return out({ id: req.id, ok: true }); }
  if (req.cmd === "fake.count") return out({ id: req.id, count });
  if (req.cmd === "where") return out({ id: req.id, ...s.where });
  if (req.cmd === "context") return out({ id: req.id, ...s.context, asked: req });
  if (req.cmd === "shotinfo") return out({ id: req.id, granted: Boolean(s.granted), windowId: 7, windows: s.windows || [] });
  if (req.cmd === "requestCapture") return out({ id: req.id, granted: false });
  out({ id: req.id, error: "unknown command", code: "bad_request" });
});
