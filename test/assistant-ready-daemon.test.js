// A fresh dev home, a real vyred: nothing names the assistant (the 0.3 order has no first-run page). It is made once the server has an owner and an AI account is connected, on events and
// one check at start (no timer); with an owner and no account Now says what to do and no assistant exists; an account disconnected later leaves the assistant in place, saying it has none.
// Stand-ins: the owner is `network.ownerSeen` and `onboard.person` and the account `onboard.claude` in config (not a real pairing and sign-in); presence is the test verifier. Verified on a real daemon: providers.list
// always reports the machine's own Claude login (account "default") as signed in, so it is deliberately not counted.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

const waitFor = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 200)); } };
const home = (t, onboard) => { const root = tempHome(t); fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { ownerSeen: true }, onboard })); return root; };
const assistant = async d => (await d.registry.call("agents.list", {}, "module:vyred")).data.find(x => x.kind === "assistant");
const stateOf = root => { try { return JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).onboard.assistantState || null; } catch { return null; } };

test("an owner and an AI account: the assistant is made on its own, named Juno", async t => {
  const root = home(t, { person: "Alex", claude: "api-key" });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const made = await waitFor(() => assistant(d));
  assert.ok(made, "the assistant was made");
  assert.equal(made.name, "juno");
});

test("an owner and no account: Now says to connect one and no assistant exists", async t => {
  const root = home(t, { person: "Alex" });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const state = await waitFor(() => stateOf(root));
  assert.equal(state && state.state, "waiting");
  assert.equal(state.why, "Connect an AI account to start your assistant");
  assert.equal(await assistant(d), undefined);
});

test("an account disconnected later: the assistant stays and says it has no account", async t => {
  const root = home(t, { person: "Alex", claude: "api-key" });
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  assert.ok(await waitFor(() => assistant(d)));
  const r = await d.registry.call("onboard.claude", { mode: "disconnect" }, "cli");
  assert.ok(!r.error, JSON.stringify(r.error));
  const state = await waitFor(() => { const s = stateOf(root); return s && s.state === "no_account" ? s : null; });
  assert.equal(state && state.why, "Your assistant has no AI account connected");
  assert.ok(await assistant(d), "the assistant did not vanish");
});
