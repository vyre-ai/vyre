// A fresh dev home, a real vyred: nothing names the assistant (the 0.3 order has no first-run page), but once the server has an owner and an AI account is connected the assistant exists,
// made by the onboard module on its own check. Stand-in: the owner and the connected account are config (`onboard.person`, `onboard.claude`), not a real pairing and sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 200)); } };

test("a fresh home with an owner and an AI account gets its assistant (the waiting state is core/onboard/assistant-ready.test.js: whether a machine has an account of its own varies)", async t => {
  const ready = tempHome(t);
  fs.writeFileSync(path.join(ready, "config.json"), JSON.stringify({ role: "box", transcripts: [], onboard: { person: "Alex", claude: "api-key" } }));
  const d = await start({ root: ready, log: () => {} });
  t.after(() => d.stop());
  const made = await waitFor(async () => (await d.registry.call("agents.list", {}, "module:vyred")).data.find(x => x.kind === "assistant"));
  assert.ok(made, "the assistant was made on its own");
  assert.equal(made.name, "juno");
});
