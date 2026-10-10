// @ts-check
// A reach-anyone reason is a claim about the code, so it is tried against the code (#116). A reason that says "no model caller" must be true on a real daemon: a bare `mcp` and a bare `harness` session,
// handed a call no tool declares, are stopped at the gates (denied, held, presence, no such tool) and never reach the tool's own input check (`bad_input`, the sign that every gate let it through). A
// reason that claims a guard the call does not hit goes red here. Also: a tool whose manifest effect is write or whose name has a mutating verb in ANY segment (`x.set-token` counts) needs a reason that
// names a guard; "read-only" does not do. Real daemon, kernel on, temp home, fakes only. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const REASONS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "reach-anyone.json"), "utf8")).tools;
const NO_MODEL = /no model caller/i;

test("a reason that says there is no model caller is true: a bare mcp and a bare harness session are stopped before the tool's own input check", { timeout: 300_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const claims = Object.entries(REASONS).filter(([, v]) => NO_MODEL.test(String(/** @type {any} */ (v).reason)));
  assert.ok(claims.length > 20, `the sweep found the claims it is meant to try (${claims.length})`);
  /** @type {string[]} */ const lies = [];
  for (const [name] of claims) {
    if (!d.registry.tools.get(name)) continue;
    for (const caller of ["mcp", "harness"]) {
      const r = await d.registry.call(name, { __probe__: 1 }, caller, {});
      const code = r && r.error ? r.error.code : "ran";
      if (code === "bad_input" || code === "ran") lies.push(`${name} (as ${caller}: ${code})`);
    }
  }
  assert.deepEqual(lies, [], "these reasons say no model caller, and a model session gets past every gate: fix the code, or the reason");
});

test("a write tool, or a name with a mutating verb in any segment, has a reason that names a guard, not read-only", () => {
  const VERB = /^(set|write|delete|remove|revoke|grant|create|update|point|release|claim|reveal|send|exec|run|open|start|stop|kill|take|reset|wipe|export|import|add|move|archive|rename|pair|unpair|enroll|sign|signin|signout|post|apply|fill|edit|answer|approve|reject|forget|accept|retire|merge|connect|disconnect|share|unshare|restore|undelete|close|resume|pause|cancel|enable|disable|publish|upload|mkdir|trash|rotate|consent|undo|redo|push|login|logout|dismiss|mute|toggle|schedule|rollover|install|uninstall|register|unregister|subscribe|unsubscribe|poll|hook|capture|record|clear|purge|prune)$/;
  const READ = /^(get|list|plan|status|read|show|check|find|search|has|info|view|peek|log|state)$/;
  const GUARD = /(callers|gate|held|presence|proof|scope|owner|guard|check|refuse|internal|modules only|assistant|person)/i;
  const weak = Object.entries(REASONS).filter(([name, v]) => {
    const r = String(/** @type {any} */ (v).reason);
    const parts = name.split(/[.-]/);
    // `x.set-token` is a write, `x.run-get`, `x.move-plan` and `undo.list` are reads: a name that ends in a read word is not judged by an earlier verb
    return parts.some(seg => VERB.test(seg)) && !READ.test(parts[parts.length - 1]) && !r.startsWith("PENDING") && (/^read-only/i.test(r) || !GUARD.test(r));
  }).map(([n, v]) => `${n}: ${/** @type {any} */ (v).reason}`);
  assert.deepEqual(weak, [], "a mutating name needs a reason that names a guard (callers list, presence proof, own-scope check, Gate)");
});
